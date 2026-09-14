// "GDSLens: Compare Layouts" -- two layouts in one webview panel, overlaid
// through one camera with one control panel over both.
//
// There is no sync controller here, and no second viewer for one to sync to.
// The page holds a single <gds-lens> holding two layouts (the library's two
// "slots"), so the camera, the panel, the rulers and the marker overlay are
// single-valued by construction: the two layouts cannot disagree about where
// the view is, because there is only one view. All this file does is open the
// panel and feed its two slots, which is why it is mostly the single editor's
// own loader machinery run twice.
//
// Deliberately not a CustomEditorProvider: there is no single resource this
// is "the" editor for, and VS Code has no notion of a custom editor over two
// files at once. A plain WebviewPanel plus a command is the right shape.
const vscode = require('vscode');
const {
    logger,
    baseName,
    uriFromStored,
    setAutoReload,
    postLyp,
    postMarkers,
    buildWebviewHtml,
    createLayoutLoader
} = require('./shared.cjs');

// Reused from the single editor's remembered-.lyp key: a .lyp is a styling
// choice independent of any one layout, so "the last one loaded, anywhere"
// is exactly as meaningful here as it is for a single GDS viewer, and reusing
// the key means a .lyp picked in one kind of view is remembered for the
// other too.
const LAST_LYP_PATH_KEY = 'GDS-Lens.lastLypPath';

const LAYOUT_EXTENSION_RE = /\.(gds|oas|oasis)(\.gz)?$/i;

class CompareViewProvider {
    constructor(context) {
        this.context = context;
        // Open comparison panels, for a future "Show Debug Tools" reach --
        // not wired to that command yet (see DEVELOPING.md-equivalent note
        // in the implementation plan: v1 leaves it scoped to single editors).
        this.panels = new Set();
    }

    // `uri`/`uris` are exactly what VS Code hands a command bound to an
    // Explorer context-menu entry invoked over a multi-selection: the
    // resource that was actually clicked, and the full current selection.
    // Both are undefined when the command runs from the palette.
    async compareLayouts(uri, uris) {
        const selected = Array.isArray(uris) && uris.length ? uris : (uri ? [uri] : []);

        if (selected.length === 0) {
            const left = await this.pickOne('Select the first layout to compare');
            if (!left) return;
            // Beside the first: two layouts being compared are usually two
            // revisions in one place, and on a remote or web host it also
            // keeps the second dialog on the filesystem the first came from.
            const right = await this.pickOne('Select the second layout to compare',
                                             vscode.Uri.joinPath(left, '..'));
            if (!right) return;
            return this.openCompare(left, right);
        }

        // The Explorer `when` clause can only gate on the clicked resource
        // looking right and *some* multi-selection being active -- there is
        // no context key for "every selected item matches" or "exactly two
        // are selected" -- so this is where a selection of the wrong shape
        // actually gets caught, rather than silently doing something odd.
        const valid = selected.filter((candidate) => LAYOUT_EXTENSION_RE.test(baseName(candidate)));
        if (valid.length !== 2 || valid.length !== selected.length) {
            vscode.window.showErrorMessage(
                'GDS Lens: select exactly two layout files (.gds/.oas/.oasis, optionally .gz) to compare.');
            return;
        }
        // Selection order isn't a contract VS Code documents, so "left" and
        // "right" are sorted for a reproducible result across repeat
        // invocations rather than left to whatever order the picker handed
        // back.
        const [left, right] = [...valid].sort((a, b) => a.toString().localeCompare(b.toString()));
        return this.openCompare(left, right);
    }

    // "GDSLens: Compare Current Layout With..." -- the other way in, from a
    // layout you already have open rather than from a selection in the
    // Explorer. `currentUri` is the open layout: the resource VS Code hands a
    // command invoked from the editor's title menu, or (from the command
    // palette, which hands nothing) whichever viewer is focused -- see
    // GdsEditorProvider.activeLayoutUri.
    async compareWithCurrent(currentUri) {
        if (!currentUri) {
            vscode.window.showInformationMessage(
                'GDS Lens: open a layout first, or click the one you want to compare and run this again.');
            return;
        }

        const other = await this.pickOne(
            `Compare ${baseName(currentUri)} with`,
            // Beside the open file, which is also what keeps the dialog on the
            // machine that file lives on: over SSH, in a container, in a
            // Codespace or on vscode.dev, the dialog runs wherever the
            // extension host runs and browses that filesystem, so starting it
            // in the current layout's own folder is both the useful default
            // and the one that cannot silently offer a local file the
            // extension host would then fail to read.
            vscode.Uri.joinPath(currentUri, '..'));
        if (!other) return;

        if (!LAYOUT_EXTENSION_RE.test(baseName(other))) {
            vscode.window.showErrorMessage(
                'GDS Lens: pick a layout file (.gds/.oas/.oasis, optionally .gz) to compare against.');
            return;
        }

        // Order is meaningful here, unlike compareLayouts' sorted pair: the
        // layout already open is the one being compared *from*, so it is A.
        return this.openCompare(currentUri, other);
    }

    async pickOne(title, defaultUri) {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Select',
            title,
            defaultUri,
            filters: { 'GDSII / OASIS layouts': ['gds', 'oas', 'oasis', 'gz'] }
        });
        return picked && picked[0];
    }

    async openCompare(uriLeft, uriRight) {
        const panel = vscode.window.createWebviewPanel(
            'GDS-Lens.compare',
            `Compare: ${baseName(uriLeft)} ↔ ${baseName(uriRight)}`,
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                // One wasm heap holding both layouts, and one WebGL2 context,
                // are worth keeping resident across a tab hide rather than
                // reparsing both layouts on return -- same reasoning as the
                // single editor.
                retainContextWhenHidden: true,
                localResourceRoots: [this.context.extensionUri]
            }
        );

        try {
            panel.webview.html = await buildWebviewHtml({
                webview: panel.webview,
                extensionUri: this.context.extensionUri,
                htmlName: 'compare.html'
            });
        } catch (err) {
            logger.appendLine('[FATAL CRASH ERROR] compare panel HTML: ' + err.stack);
            vscode.window.showErrorMessage('GDS Lens: could not open comparison view: ' + err.message);
            panel.dispose();
            return;
        }

        this.panels.add(panel);
        let disposed = false;
        const disposables = [];
        panel.onDidDispose(() => {
            disposed = true;
            this.panels.delete(panel);
            for (const d of disposables) d.dispose();
        });

        // Unstamped: there is one viewer, so a .lyp or marker message has
        // nothing to be about but the whole of it. Only the layout messages
        // below carry a pane, and only because a layout has to land in the
        // right slot.
        const post = (message) => {
            if (disposed) return;
            panel.webview.postMessage(message);
        };

        logger.appendLine('\n>>> Opening comparison: ' + uriLeft.toString() + ' <-> ' + uriRight.toString());

        const panes = {
            left: { uri: uriLeft, name: baseName(uriLeft) },
            right: { uri: uriRight, name: baseName(uriRight) }
        };
        for (const paneName of Object.keys(panes)) {
            const info = panes[paneName];
            info.loader = createLayoutLoader({
                uri: info.uri,
                // Every layout message (init/loadError/fileChanged) carries
                // which pane it's about, so webview-host.js can route it to
                // the right slot of the one viewer -- 'left' is slot A and
                // 'right' is slot B.
                //
                // 'fileChanged' is also noted here, because the viewer's
                // reload banner is one banner over two files and says nothing
                // about which of them changed when it asks to be reloaded.
                // Remembering it on this side is what lets the answer be "the
                // ones that actually changed" rather than "both, to be safe".
                post: (message) => {
                    if (message.type === 'fileChanged') {
                        info.stale = true;
                        message = {
                            ...message,
                            text: `A newer version of ${info.name} is on disk.`
                        };
                    }
                    if (message.type === 'init') info.stale = false;
                    post({ ...message, name: info.name, pane: paneName });
                },
                logPrefix: `[${paneName}] `
            });
            disposables.push({ dispose: () => info.loader.dispose() });
        }

        panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'reloadFile') {
                // One viewer, one reload banner, two files behind it. Reload
                // whichever of them reported a change -- which this side
                // already knows (see the post wrapper above), so the viewer
                // does not have to tell us and does not have to carry a
                // notion of which layout a banner belongs to.
                const stale = Object.values(panes).filter((pane) => pane.stale);
                const targets = stale.length ? stale : Object.values(panes);
                await Promise.all(targets.map((pane) => pane.loader.sendLayout(true)));
                return;
            }
            if (message.command === 'setAutoReload') {
                await setAutoReload(!!message.value);
                return;
            }
            if (message.command === 'loadLypFile') {
                const fileUri = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    openLabel: 'Load Layer Properties',
                    defaultUri: vscode.Uri.joinPath(uriLeft, '..'),
                    filters: { 'the .lyp/.lyrdb tooling Properties': ['lyp'] }
                });
                if (fileUri && fileUri[0]) {
                    await this.context.globalState.update(LAST_LYP_PATH_KEY, fileUri[0].toString());
                    await postLyp(post, fileUri[0]);
                }
            } else if (message.command === 'unloadLypFile') {
                await this.context.globalState.update(LAST_LYP_PATH_KEY, undefined);
            } else if (message.command === 'loadMarkerFile') {
                // Not remembered per layout the way the single editor does
                // (MARKER_PATHS_KEY): with two layouts and one shared marker
                // overlay, "which file's remembered marker" has no single
                // right answer, so a comparison session starts with none and
                // an explicit pick each time.
                const fileUri = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    openLabel: 'Load Marker Database',
                    defaultUri: vscode.Uri.joinPath(uriLeft, '..'),
                    filters: {
                        'Marker databases': ['lyrdb', 'rdb', 'rve', 'results', 'db', 'ascii', 'txt', 'gz'],
                        'All files': ['*']
                    }
                });
                if (fileUri && fileUri[0]) {
                    await postMarkers(post, fileUri[0]);
                }
            }
            // 'unloadMarkerFile' has nothing to forget here (see above).
        });

        const [okLeft, okRight] = await Promise.all([
            panes.left.loader.sendLayout(false),
            panes.right.loader.sendLayout(false)
        ]);
        if (!okLeft && !okRight) return;  // both failed; errors already shown

        // Re-apply the globally remembered .lyp, exactly as the single editor
        // does: one viewer, one .lyp, and it styles both layouts because it is
        // about how layers are drawn rather than about which layout they are
        // in.
        const savedLypUri = uriFromStored(this.context.globalState.get(LAST_LYP_PATH_KEY));
        if (savedLypUri && !(await postLyp(post, savedLypUri))) {
            await this.context.globalState.update(LAST_LYP_PATH_KEY, undefined);
        }
    }
}

module.exports = { CompareViewProvider };
