// The extension host. Deliberately free of Node builtins -- no fs, path, zlib or
// Buffer -- so the one source runs both in the desktop extension host and in the
// Web Worker host vscode.dev and github.dev use, where none of those exist. File
// access goes through vscode.workspace.fs, paths through vscode.Uri, and the
// two text/binary conversions Buffer used to do through TextDecoder/btoa in
// shared.cjs. See "Running on the web" in DEVELOPING.md.
const vscode = require('vscode');
const { parseCoordinatePair } = require('gds-lens/coord-parse');
const {
    logger,
    uriFromStored,
    lookupByUri,
    deleteByUri,
    autoReloadEnabled,
    setAutoReload,
    postLyp,
    postMarkers,
    buildWebviewHtml,
    createLayoutLoader
} = require('./shared.cjs');
const { CompareViewProvider } = require('./compare-provider.cjs');

// globalState key holding the URI of the most recently loaded .lyp,
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

function activate(context) {
    // Deliberately not logger.show(): revealing the panel on activation takes
    // the bottom dock away from whatever was in it (a terminal, usually) every
    // time a layout is opened. The log is still written and is one click away
    // under Output > GDSII Debugger, and "GDSLens: Toggle Debug Tools" opens
    // the in-viewer log for the half of the story the host cannot see.
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

    // "GDSLens: Compare Layouts" -- opens two layouts side by side with a
    // synced camera, layer visibility, markers and rulers (see
    // compare-provider.cjs). `uri`/`uris` are what VS Code hands a command
    // invoked from the Explorer's context menu over a multi-selection: the
    // clicked resource and the full selection. Both are undefined from the
    // command palette.
    const compareProvider = new CompareViewProvider(context);
    context.subscriptions.push(
        vscode.commands.registerCommand('GDS-Lens.compareLayouts', (uri, uris) => {
            return compareProvider.compareLayouts(uri, uris);
        })
    );

    // "GDSLens: Compare Current Layout With..." -- the same view reached from a
    // layout already open instead of from a pair selected in the Explorer,
    // which is the way round it usually comes up: you are reading a layout,
    // and *then* want to know what changed. `uri` is what VS Code hands a
    // command invoked from the editor's title menu; from the command palette
    // it is undefined and the focused viewer is the answer.
    context.subscriptions.push(
        vscode.commands.registerCommand('GDS-Lens.compareWithCurrent', (uri) => {
            return compareProvider.compareWithCurrent(uri || provider.activeLayoutUri());
        })
    );
}

class GdsEditorProvider {
    constructor(context) {
        this.context = context;
        // Every currently-open GDS webview panel, so showDebugTools() can
        // reach them (removed on dispose, see resolveCustomEditor).
        this.panels = new Set();
        // Which layout each of those panels is showing. A WeakMap so a panel
        // dropping out of the Set above is the only bookkeeping there is.
        this.uriOf = new WeakMap();
    }

    // The panel a command that acts on *one* layout should act on: the focused
    // tab, or the only open one when focus sits somewhere else entirely (the
    // command palette can be opened from anywhere). Null when that is
    // genuinely ambiguous, which the callers report rather than guessing.
    activePanel() {
        return [...this.panels].find((panel) => panel.active) ||
               (this.panels.size === 1 ? [...this.panels][0] : null);
    }

    // The layout the user is looking at, for "compare this one with...".
    activeLayoutUri() {
        const panel = this.activePanel();
        return panel ? this.uriOf.get(panel) : undefined;
    }

    toggleDebugTools() {
        for (const panel of this.panels) {
            panel.webview.postMessage({ type: 'toggleDebugTools' });
        }
    }

    // Asks for a coordinate and pans one viewer to it. Unlike toggleDebugTools
    // this targets a single panel (see activePanel): panning every open layout
    // to the same point would be nonsense.
    async goToCoordinate() {
        const target = this.activePanel();
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

            // 2. Build the HTML: script tags pointed at webview URIs, the CSP
            //    told where those come from, the parse worker's script embedded.
            webviewPanel.webview.html = await buildWebviewHtml({
                webview: webviewPanel.webview,
                extensionUri: this.context.extensionUri,
                htmlName: 'gds-lens.html'
            });

            // Track this panel so the "Show Debug Tools" command can post to
            // it, and which layout it holds so "Compare Current Layout With..."
            // knows what "current" is.
            this.panels.add(webviewPanel);
            this.uriOf.set(webviewPanel, document.uri);
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

            const loader = createLayoutLoader({ uri: document.uri, post });
            disposables.push({ dispose: () => loader.dispose() });

            webviewPanel.webview.onDidReceiveMessage(async (message) => {
                if (message.command === 'reloadFile') {
                    await loader.sendLayout(true);
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
                        filters: { 'the .lyp/.lyrdb tooling Properties': ['lyp'] }
                    };
                    const fileUri = await vscode.window.showOpenDialog(options);
                    if (fileUri && fileUri[0]) {
                        // Remember for next time (this and future viewers).
                        await this.context.globalState.update(LAST_LYP_PATH_KEY, fileUri[0].toString());
                        await postLyp(post, fileUri[0]);
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
                        // ASCII DRC results get named all sorts of things.
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
                        await postMarkers(post, fileUri[0]);
                    }
                } else if (message.command === 'unloadMarkerFile') {
                    await this.updateMarkerMap((map) => { deleteByUri(map, document.uri); });
                }
            });

            logger.appendLine('    cspSource: ' + webviewPanel.webview.cspSource);
            if (!(await loader.sendLayout(false))) return;

            // Re-apply the most recently loaded .lyp, if any. Safe to post now:
            // viewer.js's 'lypLoaded' handler waits on the wasm module, and the
            // parsed styling persists until the GDS geometry finishes loading
            // and picks it up. If the file has since moved/been deleted, drop
            // the stale remembered location so it stops trying.
            const savedLypUri = uriFromStored(this.context.globalState.get(LAST_LYP_PATH_KEY));
            if (savedLypUri && !(await postLyp(post, savedLypUri))) {
                await this.context.globalState.update(LAST_LYP_PATH_KEY, undefined);
            }

            // Re-apply this GDS file's remembered marker database, if any
            // (per-GDS, unlike the .lyp above). Same ordering guarantee: the
            // webview parses and holds the markers until geometry arrives.
            const markerMap = this.context.workspaceState.get(MARKER_PATHS_KEY) || {};
            const savedMarkerUri = uriFromStored(lookupByUri(markerMap, document.uri));
            if (savedMarkerUri && !(await postMarkers(post, savedMarkerUri))) {
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
