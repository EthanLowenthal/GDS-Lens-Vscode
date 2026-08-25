// The extension host. Deliberately free of Node builtins -- no fs, path, zlib or
// Buffer -- so the one source runs both in the desktop extension host and in the
// Web Worker host vscode.dev and github.dev use, where none of those exist. File
// access goes through vscode.workspace.fs, paths through vscode.Uri, and the
// two text/binary conversions Buffer used to do through TextDecoder/btoa below.
// See "Running on the web" in DEVELOPING.md.
const vscode = require('vscode');
const { decodeLayoutBytes } = require('gds-lens/layout-bytes');
const { parseCoordinatePair } = require('gds-lens/coord-parse');

const logger = vscode.window.createOutputChannel("GDSII Debugger");

// globalState key holding the URI of the most recently loaded KLayout .lyp,
// so it's re-applied automatically to every GDS viewer opened afterwards
// (across windows and restarts). We store the location rather than the file text
// so edits to the .lyp are picked up on reopen, and so the stored state stays
// tiny.
const LAST_LYP_PATH_KEY = 'GDS-Lens.lastLypPath';

// workspaceState key holding a { layoutUri: markerUri } map. Unlike the
// global .lyp above, marker databases are remembered *per GDS file* --
// DRC results are design-specific, so re-applying design A's markers to
// design B would be noise.
const MARKER_PATHS_KEY = 'GDS-Lens.markerPathByGds';

// workspaceState key holding a { layoutUri: [view, ...] } map of saved views --
// a name, a camera and which layers were on (see the named-views block in
// viewer.js). Per layout for the same reason marker databases are: a camera and
// a layer set only mean anything against the design they were saved from.
const NAMED_VIEWS_KEY = 'GDS-Lens.namedViewsByGds';

// How many views one layout can hold, and how long a name can be. Both exist
// because this is workspace state -- a JSON blob VS Code reads on startup -- and
// each view carries a visibility entry per layer in the design, so a PDK-scale
// layout is a few KB per saved view. Fifty is far more than anyone browses; the
// cap is there so a script driving the viewer can't grow the blob without end.
const MAX_NAMED_VIEWS = 50;
const MAX_VIEW_NAME_LENGTH = 60;

// Hard ceiling on the layout bytes. They have to be copied into the wasm
// module's 32-bit heap (4 GB, see src/wasm/CMakeLists.txt) and the flattened
// geometry built from them is always larger again, so a file this size cannot
// load however patient you are -- better to say so up front than to spend
// minutes copying it around first. Anything under this is attempted, and the
// viewer reports an out-of-memory error if it doesn't fit after all.
//
// For a gzipped layout this bounds what it *expands* to, which is the size that
// actually has to fit; the compressed file on disk is checked against it too,
// since one that big is certainly not going to expand to something smaller.
const MAX_LAYOUT_BYTES = 2 * 1024 * 1024 * 1024;

// The same ceiling for a marker database, set far lower: its text crosses to
// the webview as a JS string and is then parsed into per-item objects, so it
// costs several times its own size in the renderer process. A results database
// this large is a full-chip dump nobody can page through anyway.
const MAX_MARKER_BYTES = 512 * 1024 * 1024;

// How long the layout file has to hold a steady size+mtime before a reload
// reads it. Layout writers rarely produce one clean change event: generator
// scripts and KLayout write in chunks, and some tools write a temp file and
// rename it over the target (which arrives as delete-then-create). Reading on
// the first event would routinely hit a half-written file and report a bogus
// parse error.
const SETTLE_MS = 400;
// Give up waiting for quiet after this and read what's there -- a file being
// appended to continuously would otherwise never reload at all.
const SETTLE_TIMEOUT_MS = 30000;

// ---- Uri and encoding helpers ----------------------------------------------
// The Node-free replacements for path.basename, fs.readFileSync('utf8') and
// Buffer's base64/utf8 conversions.

// Last segment of a URI's path, for messages and for the "filename.lyp ✕" chips.
// uri.path rather than uri.fsPath: a layout opened from github.dev is a
// vscode-vfs: URI, which has no filesystem path at all.
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

// UTF-8 text to base64, the job Buffer.from(text).toString('base64') used to do.
// btoa only takes code points below 256, so the text is encoded to UTF-8 bytes
// first and fed through String.fromCharCode in chunks -- the whole ~270KB worker
// bundle spread across one apply() call would overrun the argument limit.
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

// Reads an entry out of one of the per-layout maps. Entries written before the
// web port were keyed by fsPath, so a file layout falls back to that key.
function lookupByUri(map, uri) {
    const current = map[uri.toString()];
    if (current !== undefined) return current;
    return uri.scheme === 'file' ? map[uri.fsPath] : undefined;
}

// The delete half of the same compatibility: drop the old key alongside the new
// one, so a stale pre-port entry can actually be forgotten.
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

function activate(context) {
    logger.show(true);
    logger.appendLine(">>> GDSII Extension Core Spinning Up (wasm parsing + rendering)...");

    const provider = new GdsEditorProvider(context);
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider('GDS-Lens.editor', provider, {
            // Without this, VS Code destroys the webview's DOM whenever the tab
            // is hidden and re-runs viewer.js from scratch when it comes back --
            // but resolveCustomEditor() (the only thing that posts 'init' with
            // the file bytes) runs once per editor, so the restored webview sits
            // on "Loading layout..." forever. Keeping the context also means a
            // tab switch doesn't re-parse the layout, which for a large GDS is
            // the difference between instant and tens of seconds. The cost is
            // that the wasm heap and GL context stay resident while hidden.
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    // "GDSLens: Toggle Debug Tools" -- shows/hides the upper-left readout and
    // the debug-log panel/button (all hidden by default) in every open GDS
    // viewer.
    context.subscriptions.push(
        vscode.commands.registerCommand('GDS-Lens.showDebugTools', () => {
            provider.toggleDebugTools();
        })
    );

    // "GDSLens: Go to Coordinate" -- centers the active viewer on a pasted
    // coordinate. A command rather than a permanent row in the viewer's panel:
    // coordinates arrive from outside the viewer (a DRC report, a colleague's
    // message, a generator's log), so this is reached for occasionally and with
    // a clipboard already loaded -- and the command palette's input box can
    // reject an unreadable pair as you type it, which lil-gui has no way to do.
    context.subscriptions.push(
        vscode.commands.registerCommand('GDS-Lens.goToCoordinate', () => {
            return provider.goToCoordinate();
        })
    );

    // The only in-editor way back out of auto-reload: with it on, the viewer's
    // "newer version on disk" banner (which is where you turn it on) never
    // appears, so without this the Settings UI would be the sole off switch.
    context.subscriptions.push(
        vscode.commands.registerCommand('GDS-Lens.toggleAutoReload', async () => {
            const enabled = !autoReloadEnabled();
            await setAutoReload(enabled);
            vscode.window.setStatusBarMessage(
                enabled
                    ? 'GDS Lens: auto-reload on layout change is ON'
                    : 'GDS Lens: auto-reload on layout change is OFF',
                4000
            );
        })
    );
}

class GdsEditorProvider {
    constructor(context) {
        this.context = context;
        // Every currently-open GDS webview panel, so showDebugTools() can
        // reach them (removed on dispose, see resolveCustomEditor).
        this.panels = new Set();
    }

    toggleDebugTools() {
        for (const panel of this.panels) {
            panel.webview.postMessage({ type: 'toggleDebugTools' });
        }
    }

    // Asks for a coordinate and pans one viewer to it. Unlike toggleDebugTools
    // this targets a single panel: panning every open layout to the same point
    // would be nonsense. `active` is the focused tab; falling back to a lone
    // open viewer covers the case where focus sits somewhere else entirely
    // (the palette can be opened from anywhere).
    async goToCoordinate() {
        const target = [...this.panels].find((panel) => panel.active) ||
                       (this.panels.size === 1 ? [...this.panels][0] : null);
        if (!target) {
            vscode.window.showInformationMessage(
                this.panels.size === 0
                    ? 'GDS Lens: open a layout first.'
                    : 'GDS Lens: click the layout you want to move, then run this again.');
            return;
        }

        // Microns unless a per-number unit says otherwise, and the decorations
        // coordinates arrive wrapped in are all accepted -- see coord-parse.js.
        // Validation runs as you type, so a pair that can't be read says so
        // before you commit to it rather than silently doing nothing.
        const text = await vscode.window.showInputBox({
            title: 'Go to Coordinate',
            prompt: 'Center the view on a coordinate, in µm unless a unit says otherwise',
            placeHolder: '12.5, -40    (1.2mm, 300nm)    x=8 y=2',
            validateInput: (value) => {
                if (!value.trim()) return null;  // nothing typed yet, not an error
                return parseCoordinatePair(value)
                    ? null
                    : 'Not an x, y pair — try "12.5, -40" or "(1.2mm, 300nm)"';
            }
        });
        if (!text || !text.trim()) return;

        const point = parseCoordinatePair(text);
        if (!point) return;  // validateInput already refused it
        // Whether the point is inside this layout is something only the viewer
        // knows, so it reports back (see the 'gotoResult' handler).
        target.webview.postMessage({ type: 'goToPoint', x: point.x, y: point.y });
    }

    // Reads a .lyp and pushes it to one viewer, tagged with its basename so the
    // panel can show it as a "filename.lyp ✕" chip. Returns false (without
    // throwing) if the file can't be read, so callers can drop a stale
    // remembered location.
    async postLyp(webviewPanel, uri) {
        try {
            const text = await readText(uri);
            webviewPanel.webview.postMessage({
                type: 'lypLoaded',
                text: text,
                name: baseName(uri)
            });
            return true;
        } catch (err) {
            logger.appendLine('>>> Could not read .lyp at ' + uri.toString() + ': ' + err.message);
            return false;
        }
    }

    // Marker-database twin of postLyp: reads a .lyrdb / Calibre results file
    // and pushes its text to one viewer (format sniffing happens in the
    // webview -- see marker-parsers.js). Gzipped databases are expanded here:
    // full-chip results run to hundreds of MB and are routinely stored
    // compressed, and the marker text crosses to the webview as a string, so
    // this is the last place that can deal in bytes. Returns false if
    // unreadable so callers can drop a stale remembered location.
    async postMarkers(webviewPanel, uri) {
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
            webviewPanel.webview.postMessage({
                type: 'markersLoaded',
                text: decodeText(decoded.bytes),
                name: baseName(uri)
            });
            return true;
        } catch (err) {
            logger.appendLine('>>> Could not read marker file at ' + uri.toString() + ': ' + err.message);
            return false;
        }
    }

    async updateMarkerMap(mutate) {
        const map = { ...(this.context.workspaceState.get(MARKER_PATHS_KEY) || {}) };
        mutate(map);
        await this.context.workspaceState.update(MARKER_PATHS_KEY, map);
    }

    // Saved views for one layout (see NAMED_VIEWS_KEY). Read and written whole:
    // the viewer holds the working copy and sends the entire list back after
    // every change, which makes this side a store rather than a second opinion
    // about what the list is.
    namedViewsFor(uri) {
        const map = this.context.workspaceState.get(NAMED_VIEWS_KEY) || {};
        const views = lookupByUri(map, uri);
        return Array.isArray(views) ? views : [];
    }

    async setNamedViews(uri, views) {
        const map = { ...(this.context.workspaceState.get(NAMED_VIEWS_KEY) || {}) };
        const kept = (Array.isArray(views) ? views : []).slice(0, MAX_NAMED_VIEWS);
        // An empty list drops the entry rather than storing an empty array, so
        // deleting the last saved view leaves nothing behind for this layout.
        deleteByUri(map, uri);
        if (kept.length > 0) map[uri.toString()] = kept;
        await this.context.workspaceState.update(NAMED_VIEWS_KEY, map);
    }

    // Asks for the name to save the current view under. Here rather than in the
    // webview because a webview has no prompt() to call -- and this way the box
    // validates as you type, in the editor's own idiom. `names` is what the
    // viewer already has, which is what makes "this replaces X" sayable before
    // the name is committed to.
    //
    // Takes the caller's guarded `post` rather than the panel: this awaits a
    // typed name, and closing the tab while the input box is open is exactly
    // the case that leaves a postMessage aimed at a disposed webview.
    async promptViewName(post, names) {
        const existing = Array.isArray(names) ? names : [];
        if (existing.length >= MAX_NAMED_VIEWS) {
            vscode.window.showErrorMessage(
                `GDS Lens: this layout already has ${MAX_NAMED_VIEWS} saved views — delete one first.`);
            return;
        }
        const name = await vscode.window.showInputBox({
            title: 'Save Current View',
            prompt: 'Name for this camera position and layer visibility',
            placeHolder: 'e.g. pad ring, top-left corner, metal only',
            validateInput: (value) => {
                const trimmed = value.trim();
                if (!trimmed) return null;  // nothing typed yet, not an error
                if (trimmed.length > MAX_VIEW_NAME_LENGTH) {
                    return `Keep it under ${MAX_VIEW_NAME_LENGTH} characters`;
                }
                // A warning, not a rejection: replacing a view under the same
                // name is a normal thing to want ("the overview moved").
                const clash = existing.find((other) => other.toLowerCase() === trimmed.toLowerCase());
                return clash
                    ? { message: `Replaces the saved view "${clash}"`, severity: vscode.InputBoxValidationSeverity.Warning }
                    : null;
            }
        });
        if (!name || !name.trim()) return;
        post({ type: 'saveViewName', name: name.trim() });
    }

    async openCustomDocument(uri, _openContext, _token) {
        return {
            uri: uri,
            onDidDispose: new vscode.EventEmitter().event,
            dispose: () => {}
        };
    }

        async resolveCustomEditor(document, webviewPanel, _token) {
        try {
            // 1. Grant permission to execute scripts and access the extension's
            //    own files. extensionUri rather than extensionPath: on the web
            //    the extension is served over https from the marketplace CDN and
            //    has no filesystem path to speak of.
            webviewPanel.webview.options = {
                enableScripts: true,
                localResourceRoots: [this.context.extensionUri]
            };

            // 2. Locate the webview's own assets, relative to the extension.
            // Everything the webview loads comes from the gds-lens package,
            // copied into dist/webview at build time by scripts/copy-webview.mjs.
            // Flat by design: the payload is position independent, so this side
            // only needs the directory, not a layout.
            const asset = (name) => vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', name);
            const htmlUri = asset('viewer.html');
            const loadErrorsJsUri = asset('load-errors.js');
            const wasmJsUri = asset('gdstk_wasm.js');
            const workerJsUri = asset('wasm-worker.js');

            // 3. Convert the asset locations into authenticated Webview URIs
            const jsWebviewUri = webviewPanel.webview.asWebviewUri(asset('viewer.js'));
            const cellSearchJsWebviewUri = webviewPanel.webview.asWebviewUri(asset('cell-search.js'));
            const markerParsersJsWebviewUri = webviewPanel.webview.asWebviewUri(asset('marker-parsers.js'));
            const loadErrorsJsWebviewUri = webviewPanel.webview.asWebviewUri(loadErrorsJsUri);
            const wasmJsWebviewUri = webviewPanel.webview.asWebviewUri(wasmJsUri);
            const lilGuiJsWebviewUri = webviewPanel.webview.asWebviewUri(asset('lil-gui.umd.min.js'));

            // The Worker (see viewer.js) needs gdstk_wasm.js's and
            // wasm-worker.js's full text to build its own Blob script from --
            // neither `importScripts(asWebviewUri(...))` from inside the
            // Worker nor `fetch(asWebviewUri(...))` from the main thread can
            // reach VS Code's webview resource protocol (confirmed in
            // practice: both fail, even though the identical URL loads fine
            // as a <script src> tag). Sending the ~270KB text through
            // postMessage() also reliably broke opening the editor entirely
            // (VS Code's extension-host<->webview RPC channel threw an
            // internal assertion on a payload that size). Embedding it
            // directly into the HTML document instead sidesteps both: it's
            // base64 inside an inert `type="text/plain"` <script> tag (avoids
            // any risk of the bundle's own text containing a literal
            // "</script>"), and `webview.html = ...` is a different code path
            // from postMessage's RPC channel that routinely handles content
            // this size without issue (webviews load real HTML documents
            // with inline images/fonts far larger than this all the time).
            // load-errors.js goes in too: the Worker calls describeLoadFailure
            // when a parse dies, and it can't import from the main thread.
            const workerBundleBase64 = toBase64(
                await readText(wasmJsUri) + '\n' +
                await readText(loadErrorsJsUri) + '\n' +
                await readText(workerJsUri)
            );

            // 4. Load the base HTML text and dynamically swap out the standard script references
            let htmlContent = await readText(htmlUri);
            htmlContent = htmlContent.replace('src="gdstk_wasm.js"', 'src="' + wasmJsWebviewUri.toString() + '"');
            htmlContent = htmlContent.replace('src="lil-gui.umd.min.js"', 'src="' + lilGuiJsWebviewUri.toString() + '"');
            htmlContent = htmlContent.replace('src="cell-search.js"', 'src="' + cellSearchJsWebviewUri.toString() + '"');
            htmlContent = htmlContent.replace('src="marker-parsers.js"', 'src="' + markerParsersJsWebviewUri.toString() + '"');
            htmlContent = htmlContent.replace('src="load-errors.js"', 'src="' + loadErrorsJsWebviewUri.toString() + '"');
            htmlContent = htmlContent.replace('src="viewer.js"', 'src="' + jsWebviewUri.toString() + '"');
            // The payload ships a CSP valid for an ordinary page ('self');
            // inside a webview the assets come from VS Code's own resource
            // origin instead, which is what cspSource names.
            htmlContent = htmlContent.replace(
                "script-src 'self'",
                'script-src ' + webviewPanel.webview.cspSource);
            htmlContent = htmlContent.replace('{{workerBundleBase64}}', workerBundleBase64);

            webviewPanel.webview.html = htmlContent;

            // Track this panel so the "Show Debug Tools" command can post to it.
            this.panels.add(webviewPanel);
            // Everything registered per-editor below (watcher, its event
            // handlers, the settings listener) has to go when the tab does --
            // unlike the panel itself, none of it is cleaned up automatically.
            const disposables = [];
            let disposed = false;
            webviewPanel.onDidDispose(() => {
                disposed = true;
                this.panels.delete(webviewPanel);
                for (const d of disposables) d.dispose();
            });

            // postMessage on a disposed webview throws, and every path below
            // can reach one: the reload flow awaits stats and reads, and the
            // user is free to close the tab in the middle of any of them.
            const post = (message) => {
                if (disposed) return;
                webviewPanel.webview.postMessage(message);
            };

            logger.appendLine('\n>>> Intercepted layout open call for file: ' + document.uri.toString());

            // Size+mtime of the bytes currently loaded in the viewer. The
            // watcher compares against this so events that don't reflect a
            // real content change (a touch, an editor saving an unchanged
            // buffer) don't cost a multi-second re-parse.
            let loadedStamp = null;

            const statOrNull = async () => {
                try {
                    return await vscode.workspace.fs.stat(document.uri);
                } catch {
                    return null;  // deleted, or mid-rename
                }
            };

            // Reads the file and hands it to the webview, as the first load
            // (isReload false, viewer frames the design) or a re-read
            // (isReload true, viewer keeps camera and layer visibility).
            const sendLayout = async (isReload) => {
                // Size-check before reading: the read itself allocates the
                // whole file, so on an oversized one this is the difference
                // between an instant explanation and a long stall ending in a
                // failure the webview never hears about (it would sit on the
                // loading overlay forever, since 'init' is what starts its
                // progress reporting).
                const stat = await statOrNull();
                if (!stat) {
                    logger.appendLine('>>> Layout file is not readable (deleted or moved?)');
                    post({
                        type: 'loadError',
                        message: `${baseName(document.uri)} is no longer on disk.`
                    });
                    return false;
                }
                logger.appendLine('    file size: ' + formatBytes(stat.size));
                if (stat.size > MAX_LAYOUT_BYTES) {
                    const message =
                        `This layout is ${formatBytes(stat.size)}, past the ${formatBytes(MAX_LAYOUT_BYTES)} ` +
                        `limit GDS Lens can load.\n\nThe viewer parses layouts in a 32-bit WebAssembly module, ` +
                        `which has to hold the file and the geometry built from it in 4 GB of memory.`;
                    logger.appendLine('>>> Refusing oversized layout: ' + formatBytes(stat.size));
                    post({ type: 'loadError', message: message });
                    vscode.window.showErrorMessage(`GDS Lens: layout is too large to open (${formatBytes(stat.size)}).`);
                    return false;
                }

                let fileData;
                try {
                    fileData = await vscode.workspace.fs.readFile(document.uri);
                } catch (err) {
                    // Out of memory on a large-but-allowed file, a disk error,
                    // a vanished network mount -- the viewer is already showing
                    // its progress bar, so it needs telling either way.
                    logger.appendLine('>>> Failed to read layout: ' + err.stack);
                    post({
                        type: 'loadError',
                        message: `Could not read ${baseName(document.uri)}: ${err.message}`
                    });
                    vscode.window.showErrorMessage('GDS Lens: could not read layout file: ' + err.message);
                    return false;
                }

                // A gzipped layout (.gds.gz and friends) is expanded here, so
                // everything past this point -- the webview, the parse Worker,
                // the wasm module's own GDSII/OASIS header sniffing -- sees
                // exactly the bytes an uncompressed file would have produced.
                // Detected by gzip's magic number rather than by the name, so a
                // compressed layout called ".gds" works too.
                const decoded = await decodeLayoutBytes(fileData, MAX_LAYOUT_BYTES);
                if (!decoded.ok) {
                    const name = baseName(document.uri);
                    let message;
                    if (decoded.reason === 'too-large') {
                        // storedSize is gzip's own claim about the expanded size
                        // and can be wrong (see gzipStoredSize) -- hence "about",
                        // and hence it only ever softens the wording rather than
                        // being what refused the file.
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
                    logger.appendLine('>>> Gzip decode failed (' + decoded.reason + '): ' + decoded.detail);
                    post({ type: 'loadError', message: message });
                    vscode.window.showErrorMessage(`GDS Lens: could not open ${name}.`);
                    return false;
                }
                if (decoded.gzipped) {
                    logger.appendLine('    gunzipped: ' + formatBytes(fileData.byteLength) + ' -> ' +
                                      formatBytes(decoded.bytes.byteLength));
                }
                fileData = decoded.bytes;

                // Stamped from the pre-read stat: if the file changes again
                // between the stat and the read, the watcher fires once more
                // and this compares unequal, so the newer bytes still land.
                loadedStamp = { mtime: stat.mtime, size: stat.size };

                logger.appendLine(
                    (isReload ? '>>> Re-reading changed layout' : '>>> Streaming raw layout bytes') +
                    ' down into the wasm webview context...');
                logger.appendLine('    fileData bytes: ' + fileData.byteLength);
                // fileData crosses as a raw ArrayBuffer (as it always has) --
                // only the worker bundle text needed the HTML-embedding
                // workaround above; binary ArrayBuffers here haven't shown the
                // same RPC-channel issue large strings did.
                post({
                    type: 'init',
                    fileData: Uint8Array.from(fileData).buffer,
                    reload: !!isReload
                });
                return true;
            };

            // Polls until size and mtime stop moving (see SETTLE_MS), so a
            // reload reads a finished file rather than a partial one.
            const waitForQuiet = async () => {
                const deadline = Date.now() + SETTLE_TIMEOUT_MS;
                let previous = await statOrNull();
                while (Date.now() < deadline && !disposed) {
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
            // concurrently would stack up reads of the same file. A change
            // seen while one pass is in flight re-runs the loop instead.
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
                        if (disposed) return;
                        // Gone for now -- a temp-file-plus-rename writer will
                        // fire onDidCreate once the new file lands, so this
                        // isn't the moment to complain about it.
                        if (!stat) continue;
                        if (loadedStamp &&
                            stat.mtime === loadedStamp.mtime && stat.size === loadedStamp.size) {
                            continue;
                        }
                        if (autoReloadEnabled()) {
                            logger.appendLine('>>> Layout changed on disk, auto-reloading');
                            await sendLayout(true);
                        } else {
                            logger.appendLine('>>> Layout changed on disk, offering reload');
                            post({ type: 'fileChanged' });
                        }
                    } while (changedWhileChecking && !disposed);
                } catch (err) {
                    logger.appendLine('>>> Reload check failed: ' + err.stack);
                } finally {
                    checking = false;
                }
            };

            // A RelativePattern rooted at the file's own directory (rather
            // than a workspace-relative glob) is what makes this work for
            // layouts opened from outside the workspace, which is the common
            // case -- a GDS usually lives in a build/output directory, not
            // the repo. The pattern is a non-recursive '*' with the filename
            // matched in the handler instead of baked into the glob: layout
            // names do contain glob metacharacters ("chip[v2].gds"), and
            // there's no way to escape those in a VS Code glob.
            //
            // On the web this watches whatever filesystem provider the layout
            // came from; a provider that doesn't emit events (github.dev's
            // read-only one, say) just means no change is ever noticed, which
            // for a read-only source is the right answer anyway.
            const watchedUri = document.uri.toString();
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.joinPath(document.uri, '..'), '*')
            );
            const onWatchEvent = (uri) => {
                if (uri.toString() === watchedUri) onDiskChange();
            };
            disposables.push(
                watcher,
                watcher.onDidChange(onWatchEvent),
                // Rename-over-target writers delete and re-create rather than
                // modifying in place, so a create is a content change too.
                watcher.onDidCreate(onWatchEvent)
            );

            webviewPanel.webview.onDidReceiveMessage(async (message) => {
                if (message.command === 'reloadFile') {
                    await sendLayout(true);
                    return;
                }
                if (message.command === 'gotoResult') {
                    // The pan happened either way (the camera can leave the
                    // layout's own extent), but a coordinate that isn't in this
                    // design is almost always a coordinate from another one --
                    // worth saying, and quietly, in the status bar.
                    if (!message.ok) {
                        vscode.window.setStatusBarMessage(
                            `GDS Lens: (${message.x}, ${message.y}) µm is outside this layout`, 5000);
                    }
                    return;
                }
                if (message.command === 'promptViewName') {
                    await this.promptViewName(post, message.names);
                    return;
                }
                if (message.command === 'saveNamedViews') {
                    await this.setNamedViews(document.uri, message.views);
                    return;
                }
                if (message.command === 'setAutoReload') {
                    await setAutoReload(!!message.value);
                    return;
                }
                if (message.command === 'loadLypFile') {
                    const options = {
                        canSelectMany: false,
                        openLabel: 'Load Layer Properties',
                        // Opens next to the layout rather than wherever the
                        // dialog was left. It matters most on the web, where
                        // there is no local disk to fall back on and the only
                        // readable files are the ones in the opened workspace.
                        defaultUri: vscode.Uri.joinPath(document.uri, '..'),
                        filters: { 'KLayout Properties': ['lyp'] }
                    };
                    const fileUri = await vscode.window.showOpenDialog(options);
                    if (fileUri && fileUri[0]) {
                        // Remember for next time (this and future viewers).
                        await this.context.globalState.update(LAST_LYP_PATH_KEY, fileUri[0].toString());
                        await this.postLyp(webviewPanel, fileUri[0]);
                    }
                } else if (message.command === 'unloadLypFile') {
                    // Forget the remembered .lyp so it isn't re-applied next time.
                    await this.context.globalState.update(LAST_LYP_PATH_KEY, undefined);
                } else if (message.command === 'loadMarkerFile') {
                    const options = {
                        canSelectMany: false,
                        openLabel: 'Load Marker Database',
                        defaultUri: vscode.Uri.joinPath(document.uri, '..'),
                        // Content-sniffed in the webview, so the filter is loose:
                        // Calibre ASCII results get named all sorts of things.
                        filters: {
                            'Marker databases': ['lyrdb', 'rdb', 'rve', 'results', 'db', 'ascii', 'txt', 'gz'],
                            'All files': ['*']
                        }
                    };
                    const fileUri = await vscode.window.showOpenDialog(options);
                    if (fileUri && fileUri[0]) {
                        // Remember per GDS file (see MARKER_PATHS_KEY).
                        await this.updateMarkerMap((map) => {
                            deleteByUri(map, document.uri);
                            map[document.uri.toString()] = fileUri[0].toString();
                        });
                        await this.postMarkers(webviewPanel, fileUri[0]);
                    }
                } else if (message.command === 'unloadMarkerFile') {
                    await this.updateMarkerMap((map) => { deleteByUri(map, document.uri); });
                }
            });

            logger.appendLine('    cspSource: ' + webviewPanel.webview.cspSource);
            if (!(await sendLayout(false))) return;

            // Re-apply the most recently loaded .lyp, if any. Safe to post now:
            // viewer.js's 'lypLoaded' handler waits on the wasm module, and the
            // parsed styling persists until the GDS geometry finishes loading
            // and picks it up. If the file has since moved/been deleted, drop
            // the stale remembered location so it stops trying.
            const savedLypUri = uriFromStored(this.context.globalState.get(LAST_LYP_PATH_KEY));
            if (savedLypUri && !(await this.postLyp(webviewPanel, savedLypUri))) {
                await this.context.globalState.update(LAST_LYP_PATH_KEY, undefined);
            }

            // Re-apply this GDS file's remembered marker database, if any
            // (per-GDS, unlike the .lyp above). Same ordering guarantee: the
            // webview parses and holds the markers until geometry arrives.
            const markerMap = this.context.workspaceState.get(MARKER_PATHS_KEY) || {};
            const savedMarkerUri = uriFromStored(lookupByUri(markerMap, document.uri));
            if (savedMarkerUri && !(await this.postMarkers(webviewPanel, savedMarkerUri))) {
                await this.updateMarkerMap((map) => { deleteByUri(map, document.uri); });
            }
            // This layout's saved views. Sent whether or not there are any --
            // the viewer's list is whatever arrives here, so an empty one is
            // the message that says "none saved".
            post({ type: 'namedViews', views: this.namedViewsFor(document.uri) });
        } catch (err) {
            logger.appendLine('[FATAL CRASH ERROR] ' + err.stack);
            // Best-effort: if the webview got far enough to render, it's
            // sitting on the loading overlay waiting for bytes that are never
            // coming, so give it something to show.
            try {
                webviewPanel.webview.postMessage({ type: 'loadError', message: err.message });
            } catch {
                // Panel already disposed -- the message box below is enough.
            }
            vscode.window.showErrorMessage("GDSII Viewer Error: " + err.message);
        }
    }
}

function deactivate() {}

module.exports = { activate, deactivate };
