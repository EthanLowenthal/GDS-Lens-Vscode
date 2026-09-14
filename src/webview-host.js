// The VS Code implementation of gds-lens's ViewerHost interface.
//
// This is the whole of what the viewer knows about VS Code, and it lives here
// rather than in the library: the viewer asks for a file or a name, and this
// file turns that into the postMessage round-trip the extension host speaks.
// It replaces the library's default host.js at build time (see
// scripts/copy-webview.mjs), and must load before viewer.js reads
// window.gdsLensHost.
//
// One file for both entry points, the single-layout editor and the comparison
// view, because a comparison is one viewer holding two layouts rather than two
// viewers -- so there is still one .lyp, one marker overlay, one pending pick
// and one set of saved views here. All a comparison adds is that a
// pane-stamped message names which of the two layouts it is about, which is
// the `slotOf` line below and nothing else.
//
// The interface it implements is documented in the library's
// src/hosts/browser.js.

(function () {
    const vscode = acquireVsCodeApi();
    const post = (message) => vscode.postMessage(message);

    // The extension host's protocol is one-way in both directions: a request
    // goes out as one message and its answer arrives later as a different one,
    // with nothing tying the two together. These slots are what turns that
    // back into a promise per request.
    //
    // Each answer can also arrive *unsolicited*, which is why resolving is
    // conditional rather than assumed. The host pushes 'lypLoaded' both when a
    // pick succeeds and when it restores a .lyp remembered from a previous
    // session, and 'namedViews' both on open and after the stored set changes.
    // An unsolicited one is pushed straight into the viewer instead.
    let pendingLyp = null;
    let pendingMarkers = null;
    let pendingViewName = null;
    let pendingViews = null;
    let viewer = null;
    // viewer.js calls connect() as it finishes loading, so in practice it is
    // always set before the host posts anything. Queue rather than assume it:
    // if that ordering ever slipped, an 'init' arriving first would throw
    // inside a listener and the editor would sit on an empty canvas with no
    // indication why.
    const queued = [];

    const settle = (slot, value, push) => {
        if (slot.get()) {
            const resolve = slot.get();
            slot.set(null);
            resolve(value);
        } else if (viewer) {
            push();
        }
    };

    window.gdsLensHost = {
        pickLyp: () => new Promise((resolve) => {
            // Replaces any pick still outstanding: clicking the row twice
            // should not leave the first promise unresolved forever.
            if (pendingLyp) pendingLyp(null);
            pendingLyp = resolve;
            post({ command: "loadLypFile" });
        }),
        unloadLyp: () => post({ command: "unloadLypFile" }),

        pickMarkers: () => new Promise((resolve) => {
            if (pendingMarkers) pendingMarkers(null);
            pendingMarkers = resolve;
            post({ command: "loadMarkerFile" });
        }),
        unloadMarkers: () => post({ command: "unloadMarkerFile" }),

        // The host holds these per layout URI and pushes them on open, so this
        // resolves from whichever 'namedViews' arrives first.
        loadViews: () => new Promise((resolve) => {
            pendingViews = resolve;
        }),
        saveViews: (views) => post({ command: "saveNamedViews", views }),

        // Asked for by the extension host rather than in the page: a webview
        // has no prompt() to call, and the host's input box validates as you
        // type and looks like the rest of the editor.
        promptViewName: (names) => new Promise((resolve) => {
            if (pendingViewName) pendingViewName(null);
            pendingViewName = resolve;
            post({ command: "promptViewName", names });
        }),

        // VS Code stamps the active theme kind onto <body> as vscode-light /
        // vscode-dark / vscode-high-contrast[-light] and rewrites it live when
        // the user switches themes. That is a better answer than the OS
        // preference the viewer would otherwise fall back to, so the mapping
        // from those class names to a boolean lives here, on the VS Code side
        // of the seam. The viewer's own MutationObserver on <body> picks up
        // the switch, so there is nothing to notify.
        isLightTheme: () => {
            const kinds = document.body.classList;
            // High-contrast light carries both vscode-high-contrast and
            // vscode-high-contrast-light, so the light check comes first.
            if (kinds.contains("vscode-high-contrast-light") || kinds.contains("vscode-light")) return true;
            if (kinds.contains("vscode-high-contrast") || kinds.contains("vscode-dark")) return false;
            return window.matchMedia("(prefers-color-scheme: light)").matches;
        },

        // A webview cannot reach its own asset URLs from inside a Worker:
        // neither importScripts() nor fetch() reaches the resource protocol,
        // even though the identical URL loads fine as a <script src> tag. So
        // the extension host inlines the worker's whole script, base64'd, into
        // #workerBundle and the Worker is built from that instead. The tag
        // lives in the outer document rather than the viewer's shadow root,
        // because it is the host's to fill in.
        createWorker: () => {
            const inline = document.getElementById("workerBundle");
            const text = inline ? inline.textContent.trim() : "";
            if (!text || text.startsWith("{{")) {
                // Unsubstituted placeholder: atob() on it would throw a decode
                // error that looks nothing like the missing substitution
                // behind it.
                throw new Error("worker bundle was not substituted into the webview HTML");
            }
            // atob() yields a "binary string" -- one JS char per raw byte
            // (0-255), NOT real UTF-16 text. gdstk_wasm.js contains genuine
            // non-ASCII bytes (its embedded wasm binary), so handing that
            // string straight to new Blob([...]) would have the constructor
            // UTF-8-encode it as if it were text, expanding every byte >=128
            // into a 2-byte sequence and corrupting the wasm binary (surfacing
            // as a WebAssembly.instantiate() "section was shorter than
            // expected size" CompileError inside the worker).
            const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
            return new Worker(URL.createObjectURL(new Blob([bytes], { type: "application/javascript" })));
        },

        requestReload: () => post({ command: "reloadFile" }),
        setAutoReload: (value) => post({ command: "setAutoReload", value }),
        onGotoResult: (result) => post({ command: "gotoResult", ...result }),

        connect: (api) => {
            viewer = api;
            // The extension host still has to read the file off disk, ungzip
            // it and post the bytes over, and on a large layout or a
            // vscode-vfs: URI that is a real wait. Without this the viewer
            // says "No layout loaded" for the whole of it, which reads as an
            // editor that opened onto nothing. A queued init below supersedes
            // it immediately, so this only shows when there is genuinely
            // nothing yet.
            if (viewer.showLoading) viewer.showLoading();
            while (queued.length) handle(queued.shift());
        }
    };

    // The extension host stamps every layout-specific message with the pane it
    // belongs to; the comparison view sends 'left' and 'right', the single
    // editor sends nothing at all. Both map onto the viewer's two layout
    // slots, with "a" as the default the single editor lands on.
    const slotOf = (message) => (message.pane === "right" ? "b" : "a");

    // The comparison page's "A foo.gds  B bar.gds" bar (see compare.html) --
    // the one piece of chrome outside the viewer either page has, and this is
    // where the filename arrives. A no-op in the single-file editor, whose
    // page has no such bar and whose title says the filename anyway.
    function setFileLabel(message) {
        if (!message.name) return;
        const label = document.querySelector(
            '.file-name[data-pane="' + (message.pane === "right" ? "right" : "left") + '"]');
        if (label) label.textContent = message.name;
    }

    function handle(message) {
        switch (message.type) {
            case "init":
                setFileLabel(message);
                viewer.load(message.fileData, {
                    reload: !!message.reload,
                    slot: slotOf(message),
                    name: message.name
                });
                break;
            case "loadError":
                viewer.showError(message.message);
                break;
            case "lypLoaded":
                settle(
                    { get: () => pendingLyp, set: (v) => { pendingLyp = v; } },
                    { name: message.name, text: message.text },
                    () => viewer.setLyp(message.name, message.text)
                );
                break;
            case "markersLoaded":
                settle(
                    { get: () => pendingMarkers, set: (v) => { pendingMarkers = v; } },
                    { name: message.name, text: message.text },
                    () => viewer.setMarkers(message.name, message.text)
                );
                break;
            case "namedViews":
                if (pendingViews) {
                    const resolve = pendingViews;
                    pendingViews = null;
                    resolve(message.views);
                } else if (viewer && viewer.setNamedViews) {
                    viewer.setNamedViews(message.views);
                }
                break;
            case "saveViewName":
                if (pendingViewName) {
                    const resolve = pendingViewName;
                    pendingViewName = null;
                    resolve(message.name);
                }
                break;
            case "fileChanged":
                // The text names the file when the extension host sent one,
                // which matters here in a way it does not for a single editor:
                // with two layouts open, "a newer version of this file" does
                // not say which of the two.
                viewer.showStale(message.text || "A newer version of this file is on disk.");
                break;
            case "goToPoint":
                viewer.goToPoint(message.x, message.y);
                break;
            case "toggleDebugTools":
                viewer.toggleDebug();
                break;
        }
    }

    window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || !message.type) return;
        if (!viewer) queued.push(message);
        else handle(message);
    });
}());
