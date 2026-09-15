// What GdsEditorProvider and the comparison view both need: the constants,
// the URI/encoding helpers, the webview HTML assembly, and the per-file
// load/watch/settle machinery. Split out so the two providers share one
// implementation of each rather than risking two that quietly drift --
// especially the settle-timing and error-wording details in
// createLayoutLoader, which took real iteration to get right the first time.
//
// Same portability constraint as extension.cjs: no Node builtins, since this
// is required into the same bundle that runs in the Web Worker extension
// host (see "Running on the web" in DEVELOPING.md).
const vscode = require('vscode');
const { decodeLayoutBytes } = require('gds-lens/layout-bytes');

const logger = vscode.window.createOutputChannel("GDSII Debugger");

// Hard ceiling on the layout bytes. They have to be copied into the wasm
// module's 32-bit heap (4 GB, see src/wasm/CMakeLists.txt) and the flattened
// geometry built from them is always larger again, so a file this size cannot
// load however patient you are -- better to say so up front than to spend
// minutes copying it around first. Anything under this is attempted, and the
// viewer reports an out-of-memory error if it doesn't fit after all.
//
// For a gzipped layout this bounds what it *expands* to, which is the size
// that actually has to fit; the compressed file on disk is checked against it
// too, since one that big is certainly not going to expand to something
// smaller.
const MAX_LAYOUT_BYTES = 2 * 1024 * 1024 * 1024;

// The same ceiling for a marker database, set far lower: its text crosses to
// the webview as a JS string and is then parsed into per-item objects, so it
// costs several times its own size in the renderer process. A results
// database this large is a full-chip dump nobody can page through anyway.
const MAX_MARKER_BYTES = 512 * 1024 * 1024;

// How long the layout file has to hold a steady size+mtime before a reload
// reads it. Layout writers rarely produce one clean change event: generator
// scripts and the .lyp/.lyrdb tooling write in chunks, and some tools write a
// temp file and rename it over the target (which arrives as
// delete-then-create). Reading on the first event would routinely hit a
// half-written file and report a bogus parse error.
const SETTLE_MS = 400;
// Give up waiting for quiet after this and read what's there -- a file being
// appended to continuously would otherwise never reload at all.
const SETTLE_TIMEOUT_MS = 30000;

// How long the first send waits for the webview to say it is listening before
// going ahead without it (see createReadyGate). Only a webview that never came
// up at all -- a script that 404'd, a CSP that blocked one -- should ever reach
// this, and such a page has nothing to show whatever we do; sending late is
// still better than waiting on a handshake that is never coming.
const READY_TIMEOUT_MS = 15000;

// ---- Uri and encoding helpers ----------------------------------------------
// The Node-free replacements for path.basename, fs.readFileSync('utf8') and
// Buffer's base64/utf8 conversions.

// Last segment of a URI's path, for messages and for the "filename.lyp ✕"
// chips. uri.path rather than uri.fsPath: a layout opened from github.dev is
// a vscode-vfs: URI, which has no filesystem path at all.
function baseName(uri) {
    const segments = uri.path.split('/');
    return segments[segments.length - 1] || uri.path;
}

function decodeText(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
}

async function readText(uri) {
    return decodeText(await vscode.workspace.fs.readFile(uri));
}

// UTF-8 text to base64, the job Buffer.from(text).toString('base64') used to
// do. btoa only takes code points below 256, so the text is encoded to UTF-8
// bytes first and fed through String.fromCharCode in chunks -- the whole
// ~270KB worker bundle spread across one apply() call would overrun the
// argument limit.
function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

// Turns a remembered .lyp/marker location back into a URI. Entries written
// before the web port are filesystem paths rather than URIs, so anything
// without a scheme is read as one of those. The scheme test wants two or more
// characters ahead of the colon so a Windows drive letter ("C:\...") isn't
// mistaken for one.
function uriFromStored(value) {
    if (typeof value !== 'string' || !value) return null;
    return /^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(value)
        ? vscode.Uri.parse(value)
        : vscode.Uri.file(value);
}

// Reads an entry out of one of the per-layout maps. Entries written before
// the web port were keyed by fsPath, so a file layout falls back to that key.
function lookupByUri(map, uri) {
    const current = map[uri.toString()];
    if (current !== undefined) return current;
    return uri.scheme === 'file' ? map[uri.fsPath] : undefined;
}

// The delete half of the same compatibility: drop the old key alongside the
// new one, so a stale pre-port entry can actually be forgotten.
function deleteByUri(map, uri) {
    delete map[uri.toString()];
    if (uri.scheme === 'file') delete map[uri.fsPath];
}

function autoReloadEnabled() {
    return vscode.workspace.getConfiguration('GDS-Lens').get('autoReload', false);
}

// Global rather than workspace: layouts are usually opened from outside any
// workspace folder, where a workspace-scoped write would silently not apply.
function setAutoReload(enabled) {
    return vscode.workspace.getConfiguration('GDS-Lens')
        .update('autoReload', enabled, vscode.ConfigurationTarget.Global);
}

function formatBytes(bytes) {
    if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GB';
    if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(0) + ' MB';
    return (bytes / 1024).toFixed(0) + ' KB';
}

// Reads a .lyp and pushes it through `post`, tagged with its basename so the
// panel can show it as a "filename.lyp ✕" chip. Returns false (without
// throwing) if the file can't be read, so callers can drop a stale remembered
// location. `post` rather than a webview panel: the comparison view applies
// this to a shared overlay across two panes, and the single editor applies it
// to its one -- both are just "a function that posts to the webview".
async function postLyp(post, uri) {
    try {
        const text = await readText(uri);
        post({ type: 'lypLoaded', text: text, name: baseName(uri) });
        return true;
    } catch (err) {
        logger.appendLine('>>> Could not read .lyp at ' + uri.toString() + ': ' + err.message);
        return false;
    }
}

// Marker-database twin of postLyp: reads a .lyrdb / ASCII DRC results file
// and pushes its text (format sniffing happens in the webview -- see
// marker-parsers.js). Gzipped databases are expanded here: full-chip results
// run to hundreds of MB and are routinely stored compressed, and the marker
// text crosses to the webview as a string, so this is the last place that can
// deal in bytes. Returns false if unreadable so callers can drop a stale
// remembered location.
async function postMarkers(post, uri) {
    try {
        const raw = await vscode.workspace.fs.readFile(uri);
        const decoded = await decodeLayoutBytes(raw, MAX_MARKER_BYTES);
        if (!decoded.ok) {
            logger.appendLine('>>> Could not decompress marker file at ' + uri.toString() + ': ' + decoded.detail);
            vscode.window.showErrorMessage(
                decoded.reason === 'too-large'
                    ? `${baseName(uri)} expands past the ${formatBytes(MAX_MARKER_BYTES)} marker limit.`
                    : `Could not decompress ${baseName(uri)} — the file looks gzipped but is corrupt.`
            );
            return false;
        }
        if (decoded.gzipped) {
            logger.appendLine('    gunzipped markers: ' + formatBytes(raw.byteLength) + ' -> ' +
                formatBytes(decoded.bytes.byteLength));
        }
        post({ type: 'markersLoaded', text: decodeText(decoded.bytes), name: baseName(uri) });
        return true;
    } catch (err) {
        logger.appendLine('>>> Could not read marker file at ' + uri.toString() + ': ' + err.message);
        return false;
    }
}

// Assembles one webview's HTML from a payload page copied out of the gds-lens
// package (scripts/copy-webview.mjs), rewriting it the way every host here
// needs: script tags pointed at authenticated webview URIs, the CSP told
// where those actually come from, and the parse worker's script embedded
// inline. `htmlName` is the payload file to start from -- 'gds-lens.html' for
// the single editor, 'compare.html' for the comparison view -- everything
// else about the rewrite is identical between them.
async function buildWebviewHtml({ webview, extensionUri, htmlName }) {
    // Everything the webview loads comes from the gds-lens package, copied
    // into dist/webview at build time. Flat by design: the payload is
    // position independent, so this only needs the directory, not a layout.
    const asset = (name) => vscode.Uri.joinPath(extensionUri, 'dist', 'webview', name);
    const htmlUri = asset(htmlName);
    const wasmJsUri = asset('gds-lens-engine.js');
    const workerJsUri = asset('gds-lens-worker.js');

    // The Worker (see viewer.js) needs gds-lens-engine.js's and
    // gds-lens-worker.js's full text to build its own Blob script from --
    // neither `importScripts(asWebviewUri(...))` from inside the Worker nor
    // `fetch(asWebviewUri(...))` from the main thread can reach VS Code's
    // webview resource protocol (confirmed in practice: both fail, even
    // though the identical URL loads fine as a <script src> tag). Sending the
    // ~270KB text through postMessage() also reliably broke opening the
    // editor entirely (VS Code's extension-host<->webview RPC channel threw
    // an internal assertion on a payload that size). Embedding it directly
    // into the HTML document instead sidesteps both: it's base64 inside an
    // inert `type="text/plain"` <script> tag (avoids any risk of the
    // bundle's own text containing a literal "</script>"), and
    // `webview.html = ...` is a different code path from postMessage's RPC
    // channel that routinely handles content this size without issue
    // (webviews load real HTML documents with inline images/fonts far larger
    // than this all the time). describeLoadFailure is bundled into
    // gds-lens-worker.js itself, so only these two files are needed.
    const workerBundleBase64 = toBase64(
        await readText(wasmJsUri) + '\n' +
        await readText(workerJsUri)
    );

    let htmlContent = await readText(htmlUri);
    // Every <script src="name.js"> in the payload, rewritten in one sweep
    // rather than one hand-written line each. The payload references its
    // siblings by bare filename, which a webview cannot resolve: they have to
    // become authenticated webview URIs. Doing this generically matters more
    // than it looks -- a file added to the payload (or, here, to compare.html
    // alone) but forgotten in a hand-written list fails silently. It 404s,
    // the global it defined is undefined, and the viewer sits on its loading
    // bar with nothing in the log to say why.
    htmlContent = htmlContent.replace(
        /src="([A-Za-z0-9_.-]+\.js)"/g,
        (_match, name) => 'src="' + webview.asWebviewUri(asset(name)).toString() + '"');
    // The payload ships a CSP valid for an ordinary page ('self'); inside a
    // webview the scripts come from somewhere else, and the policy has to
    // name wherever that turns out to be.
    //
    // Two places, in practice. On the desktop asWebviewUri rewrites the
    // file: URIs onto VS Code's own resource origin, which is exactly what
    // cspSource names. On the web it rewrites nothing: an http(s) URI is
    // already something the browser can load, so it comes back untouched,
    // and on vscode.dev the extension is served from
    // https://<publisher>.vscode-unpkg.net -- an origin cspSource says
    // nothing about. Naming cspSource alone there blocks every script in the
    // payload and the editor comes up blank with only CSP violations in the
    // webview console to say so.
    //
    // Rather than restate VS Code's rule for which host rewrites what, read
    // the origin off a URI that has actually been through asWebviewUri and
    // name that as well. On the desktop it is the resource origin cspSource
    // already covers, and saying it twice costs nothing. gds-lens.js is the
    // one script every payload here loads (the element definition), so it's
    // a stable thing to probe regardless of which page this is.
    const scriptOrigin = (uri) =>
        (uri.scheme === 'http' || uri.scheme === 'https') && uri.authority
            ? ' ' + uri.scheme + '://' + uri.authority
            : '';
    htmlContent = htmlContent.replace(
        "script-src 'self'",
        'script-src ' + webview.cspSource
        + scriptOrigin(webview.asWebviewUri(asset('gds-lens.js'))));
    // The tag is ours to add, not the payload's to carry: the library serves
    // plain pages, and only a VS Code host needs the worker inlined. It goes
    // in the outer document (createWorker in webview-host.js reads it by id)
    // and ahead of every real script, as type="text/plain" so
    // nothing executes it -- base64 also keeps a literal "</script>" in the
    // bundle's own text from ending the tag early.
    htmlContent = htmlContent.replace(
        '<body>',
        '<body>\n    <script type="text/plain" id="workerBundle">' +
        workerBundleBase64 + '</script>');
    return htmlContent;
}

// Everything one open layout needs from disk: the size-checked, gzip-aware
// read that turns into an 'init' message, and the watch/settle/auto-reload
// loop that turns a file change into either a silent re-read or a
// "newer version on disk" banner. `post` is the caller's already
// dispose-guarded postMessage wrapper; `logPrefix` distinguishes which
// pane's log lines are which when a comparison view runs two of these at
// once.
function createLayoutLoader({ uri, post, logPrefix = '' }) {
    // Size+mtime of the bytes currently loaded in the viewer. The watcher
    // compares against this so events that don't reflect a real content
    // change (a touch, an editor saving an unchanged buffer) don't cost a
    // multi-second re-parse.
    let loadedStamp = null;
    let stopped = false;

    const statOrNull = async () => {
        try {
            return await vscode.workspace.fs.stat(uri);
        } catch {
            return null;  // deleted, or mid-rename
        }
    };

    // Reads the file and hands it to the webview, as the first load
    // (isReload false, viewer frames the design) or a re-read (isReload true,
    // viewer keeps camera and layer visibility).
    const sendLayout = async (isReload) => {
        // Size-check before reading: the read itself allocates the whole
        // file, so on an oversized one this is the difference between an
        // instant explanation and a long stall ending in a failure the
        // webview never hears about (it would sit on the loading overlay
        // forever, since 'init' is what starts its progress reporting).
        const stat = await statOrNull();
        if (!stat) {
            logger.appendLine(logPrefix + '>>> Layout file is not readable (deleted or moved?)');
            post({ type: 'loadError', message: `${baseName(uri)} is no longer on disk.` });
            return false;
        }
        logger.appendLine(logPrefix + '    file size: ' + formatBytes(stat.size));
        if (stat.size > MAX_LAYOUT_BYTES) {
            const message =
                `This layout is ${formatBytes(stat.size)}, past the ${formatBytes(MAX_LAYOUT_BYTES)} ` +
                `limit GDS Lens can load.\n\nThe viewer parses layouts in a 32-bit WebAssembly module, ` +
                `which has to hold the file and the geometry built from it in 4 GB of memory.`;
            logger.appendLine(logPrefix + '>>> Refusing oversized layout: ' + formatBytes(stat.size));
            post({ type: 'loadError', message: message });
            vscode.window.showErrorMessage(`GDS Lens: layout is too large to open (${formatBytes(stat.size)}).`);
            return false;
        }

        let fileData;
        try {
            fileData = await vscode.workspace.fs.readFile(uri);
        } catch (err) {
            // Out of memory on a large-but-allowed file, a disk error, a
            // vanished network mount -- the viewer is already showing its
            // progress bar, so it needs telling either way.
            logger.appendLine(logPrefix + '>>> Failed to read layout: ' + err.stack);
            post({ type: 'loadError', message: `Could not read ${baseName(uri)}: ${err.message}` });
            vscode.window.showErrorMessage('GDS Lens: could not read layout file: ' + err.message);
            return false;
        }

        // A gzipped layout (.gds.gz and friends) is expanded here, so
        // everything past this point -- the webview, the parse Worker, the
        // wasm module's own GDSII/OASIS header sniffing -- sees exactly the
        // bytes an uncompressed file would have produced. Detected by gzip's
        // magic number rather than by the name, so a compressed layout
        // called ".gds" works too.
        const decoded = await decodeLayoutBytes(fileData, MAX_LAYOUT_BYTES);
        if (!decoded.ok) {
            const name = baseName(uri);
            let message;
            if (decoded.reason === 'too-large') {
                // storedSize is gzip's own claim about the expanded size and
                // can be wrong (see gzipStoredSize) -- hence "about", and
                // hence it only ever softens the wording rather than being
                // what refused the file.
                const expands = decoded.storedSize
                    ? `expands to about ${formatBytes(decoded.storedSize)}`
                    : 'expands past';
                message =
                    `${name} ${expands}, past the ${formatBytes(MAX_LAYOUT_BYTES)} limit ` +
                    `GDS Lens can load.\n\nThe viewer parses layouts in a 32-bit WebAssembly ` +
                    `module, which has to hold the file and the geometry built from it in ` +
                    `4 GB of memory.`;
            } else {
                message =
                    `Could not decompress ${name}.\n\nIt starts with a gzip header, but the ` +
                    `compressed data can't be read -- the file may be truncated, or still ` +
                    `being written.\n\n(${decoded.detail})`;
            }
            logger.appendLine(logPrefix + '>>> Gzip decode failed (' + decoded.reason + '): ' + decoded.detail);
            post({ type: 'loadError', message: message });
            vscode.window.showErrorMessage(`GDS Lens: could not open ${name}.`);
            return false;
        }
        if (decoded.gzipped) {
            logger.appendLine(logPrefix + '    gunzipped: ' + formatBytes(fileData.byteLength) + ' -> ' +
                              formatBytes(decoded.bytes.byteLength));
        }
        fileData = decoded.bytes;

        // Stamped from the pre-read stat: if the file changes again between
        // the stat and the read, the watcher fires once more and this
        // compares unequal, so the newer bytes still land.
        loadedStamp = { mtime: stat.mtime, size: stat.size };

        logger.appendLine(logPrefix +
            (isReload ? '>>> Re-reading changed layout' : '>>> Streaming raw layout bytes') +
            ' down into the wasm webview context...');
        logger.appendLine(logPrefix + '    fileData bytes: ' + fileData.byteLength);
        // fileData crosses as a raw ArrayBuffer (as it always has) -- only
        // the worker bundle text needed the HTML-embedding workaround in
        // buildWebviewHtml; binary ArrayBuffers here haven't shown the same
        // RPC-channel issue large strings did. `name` lets a host label which
        // file this is without reaching back into extension-host state (the
        // comparison view's per-pane label; the single editor ignores it).
        post({
            type: 'init',
            fileData: Uint8Array.from(fileData).buffer,
            reload: !!isReload,
            name: baseName(uri)
        });
        return true;
    };

    // Polls until size and mtime stop moving (see SETTLE_MS), so a reload
    // reads a finished file rather than a partial one.
    const waitForQuiet = async () => {
        const deadline = Date.now() + SETTLE_TIMEOUT_MS;
        let previous = await statOrNull();
        while (Date.now() < deadline && !stopped) {
            await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
            const current = await statOrNull();
            if (current && previous &&
                current.size === previous.size && current.mtime === previous.mtime) {
                return current;
            }
            previous = current;
        }
        return previous;
    };

    // Serialized: watcher events arrive in bursts, and running this
    // concurrently would stack up reads of the same file. A change seen
    // while one pass is in flight re-runs the loop instead.
    let checking = false;
    let changedWhileChecking = false;
    const onDiskChange = async () => {
        if (checking) {
            changedWhileChecking = true;
            return;
        }
        checking = true;
        try {
            do {
                changedWhileChecking = false;
                const stat = await waitForQuiet();
                if (stopped) return;
                // Gone for now -- a temp-file-plus-rename writer will fire
                // onDidCreate once the new file lands, so this isn't the
                // moment to complain about it.
                if (!stat) continue;
                if (loadedStamp &&
                    stat.mtime === loadedStamp.mtime && stat.size === loadedStamp.size) {
                    continue;
                }
                if (autoReloadEnabled()) {
                    logger.appendLine(logPrefix + '>>> Layout changed on disk, auto-reloading');
                    await sendLayout(true);
                } else {
                    logger.appendLine(logPrefix + '>>> Layout changed on disk, offering reload');
                    post({ type: 'fileChanged' });
                }
            } while (changedWhileChecking && !stopped);
        } catch (err) {
            logger.appendLine(logPrefix + '>>> Reload check failed: ' + err.stack);
        } finally {
            checking = false;
        }
    };

    // A RelativePattern rooted at the file's own directory (rather than a
    // workspace-relative glob) is what makes this work for layouts opened
    // from outside the workspace, which is the common case -- a GDS usually
    // lives in a build/output directory, not the repo. The pattern is a
    // non-recursive '*' with the filename matched in the handler instead of
    // baked into the glob: layout names do contain glob metacharacters
    // ("chip[v2].gds"), and there's no way to escape those in a VS Code glob.
    //
    // On the web this watches whatever filesystem provider the layout came
    // from; a provider that doesn't emit events (github.dev's read-only one,
    // say) just means no change is ever noticed, which for a read-only
    // source is the right answer anyway.
    const watchedUri = uri.toString();
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), '*')
    );
    const onWatchEvent = (changedUri) => {
        if (changedUri.toString() === watchedUri) onDiskChange();
    };
    const subscriptions = [
        watcher,
        watcher.onDidChange(onWatchEvent),
        // Rename-over-target writers delete and re-create rather than
        // modifying in place, so a create is a content change too.
        watcher.onDidCreate(onWatchEvent)
    ];

    return {
        sendLayout,
        dispose() {
            stopped = true;
            for (const subscription of subscriptions) subscription.dispose();
        }
    };
}

// The handshake in front of the first send.
//
// A message posted to a webview before its scripts have run is not queued for
// them: VS Code's webview preload holds what the extension host posts only
// until it decides the content document has loaded, and hookupOnLoadHandlers
// (vs/workbench/contrib/webview/browser/pre/index.html) gives the document
// 200ms to fire 'load' before declaring it loaded anyway and flushing
// everything into it. The viewer payload is ~1.5 MB of engine, element and
// inlined worker bundle, so a cold window -- extension host still activating,
// nothing in any cache, the webview's service worker still installing -- goes
// past that routinely. The flush then delivers 'init' to a document whose
// 'message' listener does not exist yet, window message events are not
// replayed for listeners that arrive late, and the layout bytes are simply
// gone. The viewer sits on "Fetching layout..." for good, with the host log
// saying it sent the file and the viewer log never mentioning it.
//
// So the page announces itself instead (the `ready` post at the end of
// webview-host.js) and nothing is sent until it does. The listener has to be
// registered *before* webview.html is assigned -- assigning it is what starts
// the page loading, and onDidReceiveMessage buffers nothing either, so the
// same race runs in the other direction.
//
// A later 'ready' is a webview that reloaded and lost everything it held --
// VS Code re-creates the content frame on its own account, and "Developer:
// Reload Webviews" does it on the user's -- so it is a request for the whole
// payload again rather than a handshake, and `onReconnect` resends it.
function createReadyGate({ webview, onReconnect, logPrefix = '' }) {
    // Whether the first send has been let through, by a 'ready' or by the
    // timeout. Everything after that point is a reload asking to be re-fed.
    let released = false;
    let announce = null;

    const subscription = webview.onDidReceiveMessage((message) => {
        if (!message || message.command !== 'ready') return;
        if (!released) {
            released = true;
            if (announce) announce();
            return;
        }
        logger.appendLine(logPrefix + '>>> Webview reloaded; re-sending its layout');
        Promise.resolve(onReconnect()).catch((err) => {
            logger.appendLine(logPrefix + '>>> Re-send after a webview reload failed: ' + err.stack);
        });
    });

    return {
        async wait() {
            if (released) return;
            let timer;
            await new Promise((resolve) => {
                announce = resolve;
                timer = setTimeout(() => {
                    released = true;
                    logger.appendLine(logPrefix +
                        '>>> No "ready" from the webview after ' + READY_TIMEOUT_MS +
                        'ms -- sending the layout anyway');
                    resolve();
                }, READY_TIMEOUT_MS);
            });
            clearTimeout(timer);
            announce = null;
        },
        dispose() {
            subscription.dispose();
            // A tab closed while we were waiting: release the wait rather than
            // leaving its timeout to hold the closure for the rest of the
            // timeout. The caller checks for a disposed panel before sending.
            released = true;
            if (announce) {
                const resolve = announce;
                announce = null;
                resolve();
            }
        }
    };
}

module.exports = {
    logger,
    MAX_LAYOUT_BYTES,
    MAX_MARKER_BYTES,
    SETTLE_MS,
    SETTLE_TIMEOUT_MS,
    READY_TIMEOUT_MS,
    baseName,
    decodeText,
    readText,
    toBase64,
    uriFromStored,
    lookupByUri,
    deleteByUri,
    autoReloadEnabled,
    setAutoReload,
    formatBytes,
    postLyp,
    postMarkers,
    buildWebviewHtml,
    createLayoutLoader,
    createReadyGate
};
