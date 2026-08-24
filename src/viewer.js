// Thin bootstrap: instantiate the wasm module and relay postMessage payloads
// from the extension host into it. JS never touches GDS/GL data -- that all
// lives in wasm/renderer.cpp (GL context + shaders + camera + input) and
// wasm/bindings.cpp (gdstk GDSII/OASIS parsing), which attach directly to
// #glCanvas and the DOM themselves. The control surface (load .lyp button +
// per-layer visibility toggles) is built with lil-gui
// (vendor/lil-gui.umd.min.js).
//
// Loading a layout file is split across a Worker (see wasm-worker.js) and this
// main-thread module: the Worker instantiates its own copy of the same wasm
// module and runs parseGdsToLayers() (parse + flatten + triangulate, no
// GL/DOM) so the canvas/lil-gui panel stay responsive on very large files,
// reporting progress via 'gdsProgress' messages along the way. Once it posts
// back the flattened geometry, this thread's Module.uploadLayers() does the
// (fast, GPU-bound) VBO upload -- the only part that needs the GL context.

// On-screen debug log (see #debugPanel in viewer.html): mirrors every
// console.log/error call here, plus 'gdsLog' messages relayed from the
// Worker (which has no DOM of its own to render into), so debugging doesn't
// depend on getting the right DevTools window attached to the right webview
// -- the log is just selectable text in the page itself.
const debugLogEl = document.getElementById("debugLog");
function safeStringify(arg) {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return arg.stack || arg.message;
    try {
        return JSON.stringify(arg);
    } catch {
        return String(arg);
    }
}
function appendDebugLine(text, isError) {
    if (!debugLogEl) return;
    const line = document.createElement("div");
    if (isError) line.className = "err";
    line.textContent = `[${new Date().toISOString().slice(11, 23)}] ${text}`;
    debugLogEl.appendChild(line);
    debugLogEl.scrollTop = debugLogEl.scrollHeight;
}
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);
console.log = (...args) => {
    originalConsoleLog(...args);
    appendDebugLine(args.map(safeStringify).join(" "), false);
};
console.error = (...args) => {
    originalConsoleError(...args);
    appendDebugLine(args.map(safeStringify).join(" "), true);
};
// Null-guarded: a missing element here (e.g. a webview still holding stale
// HTML from before this panel existed) must not throw and abort the rest of
// this script -- everything below, including the window "message" listener
// that shows the loading bar at all, depends on this file finishing setup.
const debugPanelEl = document.getElementById("debugPanel");
const debugToggleBtn = document.getElementById("debugToggleBtn");
if (debugToggleBtn && debugPanelEl) {
    debugToggleBtn.addEventListener("click", () => {
        debugPanelEl.classList.toggle("hidden");
    });
}
const debugCopyBtn = document.getElementById("debugCopyBtn");
if (debugCopyBtn) {
    debugCopyBtn.addEventListener("click", () => {
        const text = debugLogEl ? debugLogEl.innerText : "";
        navigator.clipboard.writeText(text).then(
            () => console.log("[GDS] debug log copied to clipboard"),
            (err) => {
                // Clipboard API can be blocked in a sandboxed webview -- fall back
                // to selecting the text so the user can Cmd/Ctrl+C manually.
                console.error("[GDS] clipboard write failed, select-all instead:", err);
                if (!debugLogEl) return;
                const range = document.createRange();
                range.selectNodeContents(debugLogEl);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            }
        );
    });
}

console.log("[GDS] viewer.js starting to execute");

window.onerror = (msg, url, line, col, err) => {
    console.error("[GDS] window.onerror:", msg, "at", url + ":" + line + ":" + col, err && err.stack);
};
window.addEventListener("unhandledrejection", (event) => {
    console.error("[GDS] unhandled promise rejection on main thread:", event.reason);
});

const vscode = acquireVsCodeApi();
console.log("[GDS] acquireVsCodeApi() OK, typeof createGdstkModule:", typeof createGdstkModule, "typeof lil:", typeof lil, "typeof Worker:", typeof Worker, "typeof Blob:", typeof Blob);

const gui = new lil.GUI({ width: 260 });
const actions = {
    // Clicking the row always opens the file dialog (load, or replace the
    // current file); the injected ✕ (see setFileChip) handles unloading.
    loadLypFile: () => vscode.postMessage({ command: "loadLypFile" }),
    loadMarkerFile: () => vscode.postMessage({ command: "loadMarkerFile" }),
    resetView: () => modulePromise.then((Module) => Module.resetView()),
    showInfill: false,
    showText: false,
    mergeOverlaps: false,
    // On by default -- matches g_show_grid in renderer.cpp, which is the
    // renderer's own initial state (nothing pushes this value down at startup).
    showGrid: true
};
// ---- Display folder ----
// Everything here is either set once and forgotten (the render toggles, the
// .lyp) or reached for occasionally (a marker database, refitting the view) --
// so it's one closed folder rather than eight rows above the layer list, which
// is what the panel is actually for. Closed by default: nothing in here has to
// be visible to read a layout.
const displayFolder = gui.addFolder("Display");
displayFolder.close();

displayFolder.add(actions, "showInfill").name("Infill")
    .onChange((show) => modulePromise.then((Module) => Module.setShowInfill(show)));
// Draw the layout's own labels (GDSII/OASIS TEXT elements) at a fixed
// on-screen size, in each label's layer color -- off by default because a
// full chip's worth of text buries the geometry it sits on.
const textController = displayFolder.add(actions, "showText").name("Text")
    .onChange((show) => modulePromise.then((Module) => Module.setShowText(show)));
textController.domElement.title = "Show layout text labels, drawn in their layer's color";
// Draw each layer as the union of its polygons (boundary + fill only, no
// internal edges) -- a pure render-mode toggle, no re-parse involved.
displayFolder.add(actions, "mergeOverlaps").name("Merge Overlaps")
    .onChange((on) => modulePromise.then((Module) => Module.setMergeMode(on)));
// Background reference grid, pitched at a power-of-ten nm/µm/mm step that
// follows the zoom (see draw_grid).
const gridController = displayFolder.add(actions, "showGrid").name("Grid")
    .onChange((show) => modulePromise.then((Module) => Module.setShowGrid(show)));
gridController.domElement.title = "Show the background grid, spaced at a round step that follows the zoom";

// The two file loaders live under the toggles because that's the order they're
// used in over a session: the render toggles are a preference, and a .lyp or a
// marker database is loaded once (and then remembered across reopens by the
// extension host, so most sessions never touch these rows at all).
const lypController = displayFolder.add(actions, "loadLypFile").name("Load KLayout .lyp File");
const markerController = displayFolder.add(actions, "loadMarkerFile").name("Load Marker File (.lyrdb / DRC)");
displayFolder.add(actions, "resetView").name("Reset View");

// ---- Interaction mode (Pan / Measure) ----
// The canvas can only do one thing with a click, so the two are exclusive
// modes rather than an "on top of panning" toggle: in Pan mode a drag moves
// the view, in Measure mode clicks place the ruler's two ends (see
// on_mousedown in renderer.cpp) and dragging does nothing. Rendered as a
// segmented pair of buttons -- a checkbox would say "measure is an extra",
// which is exactly the wrong mental model. Wasm only needs the boolean; the
// row below is the whole difference.
const MODES = [
    { id: "pan", label: "Pan", title: "Drag to pan the view, wheel to zoom" },
    {
        id: "measure",
        label: "Measure",
        title: "Click two points to measure between them. Snaps to nearby vertices and edges " +
               "(Alt to place freely), Shift constrains to horizontal/vertical, Esc cancels."
    }
];
let currentMode = "pan";
const modeButtons = new Map();

// Built by hand instead of via gui.add(): lil-gui has no segmented-control
// type. Reusing its own .lil-controller/.lil-name/.lil-widget classes means
// the row picks up the panel's row metrics and theme colors for free (the
// button styling itself lives in viewer.html).
const modeRow = document.createElement("div");
modeRow.className = "lil-controller mode-row";
const modeName = document.createElement("div");
modeName.className = "lil-name";
modeName.textContent = "Mode";
const modeWidget = document.createElement("div");
modeWidget.className = "lil-widget mode-widget";
for (const mode of MODES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = mode.label;
    btn.title = mode.title;
    btn.addEventListener("click", () => setMode(mode.id));
    modeWidget.appendChild(btn);
    modeButtons.set(mode.id, btn);
}
modeRow.appendChild(modeName);
modeRow.appendChild(modeWidget);
// First row in the panel, above the Display folder and the layer list: it's the
// one control here that changes what a click on the canvas does, so it's the one
// that has to be found without opening anything. prepend rather than append
// because the folders and the layer list are added to $children by the load
// path, which runs long after this.
gui.$children.prepend(modeRow);

function setMode(id) {
    if (currentMode === id) return;
    currentMode = id;
    for (const [modeId, btn] of modeButtons) {
        btn.classList.toggle("mode-active", modeId === id);
    }
    // Leaving measure mode drops a half-placed ruler but keeps the finished
    // ones (see setMeasureMode in renderer.cpp) -- so the row below has to be
    // re-read either way.
    modulePromise.then((Module) => {
        Module.setMeasureMode(id === "measure");
        refreshRulerRow(Module);
    });
}
modeButtons.get(currentMode).classList.add("mode-active");

// ---- Rulers ----
// Measurements persist once placed and stack up, so there has to be a way to
// take them down that doesn't involve re-entering the mode that made them. The
// row only exists while there is something to clear.
const rulerRow = document.createElement("div");
rulerRow.className = "lil-controller mode-row ruler-row";
rulerRow.style.display = "none";
const rulerName = document.createElement("div");
rulerName.className = "lil-name";
rulerName.textContent = "Rulers";
const rulerWidget = document.createElement("div");
rulerWidget.className = "lil-widget mode-widget";
const rulerClearBtn = document.createElement("button");
rulerClearBtn.type = "button";
rulerClearBtn.title = "Remove every measurement on the canvas (also Esc, once nothing is being placed)";
rulerClearBtn.addEventListener("click", () => {
    modulePromise.then((Module) => {
        Module.clearMeasurements();
        refreshRulerRow(Module);
    });
});
rulerWidget.appendChild(rulerClearBtn);
rulerRow.append(rulerName, rulerWidget);
modeRow.after(rulerRow);

function refreshRulerRow(Module) {
    const count = Module.measurementCount();
    rulerRow.style.display = count > 0 ? "" : "none";
    rulerClearBtn.textContent = `Clear ${count}`;
}

// Rulers are placed by clicking the canvas, and renderer.cpp owns that mouse
// handling entirely -- this side never sees the result. So the count is re-read
// after any click that could have finished one. setTimeout(0) rather than
// handling it inline because it has to run after the whole event dispatch,
// whichever order the renderer's listener and this one were registered in.
const glCanvas = document.getElementById("glCanvas");
if (glCanvas) {
    glCanvas.addEventListener("mousedown", () => {
        if (currentMode !== "measure") return;
        setTimeout(() => modulePromise.then(refreshRulerRow), 0);
    });
}

// Reflects a loaded-file state in a lil-gui button row (used by both the
// .lyp and marker-file rows). With no file it's a plain load button. Once a
// file is loaded it shows the filename with an ✕ on the right that unloads
// it via onUnload. Clicking the filename itself re-opens the dialog to swap
// in a different file. (The .lyp-* CSS classes are shared by both rows.)
function setFileChip(controller, name, { idleLabel, idleTitle, unloadTitle, onUnload }) {
    // Remove any ✕ from a previous loaded state before re-deciding.
    const existingX = controller.domElement.querySelector(".lyp-unload");
    if (existingX) existingX.remove();
    controller.domElement.classList.toggle("lyp-loaded", !!name);

    if (!name) {
        controller.name(idleLabel);
        controller.domElement.title = idleTitle;
        return;
    }

    controller.name(name);
    controller.domElement.title = `${name} — click to replace, ✕ to unload`;
    const x = document.createElement("span");
    x.className = "lyp-unload";
    x.textContent = "✕";
    x.title = unloadTitle;
    x.addEventListener("click", (event) => {
        // The ✕ overlays the row's full-width <button> but isn't inside it,
        // so a click here never reaches the load-dialog handler; stopping
        // propagation just makes that explicit.
        event.stopPropagation();
        onUnload();
    });
    controller.domElement.appendChild(x);
}

function setLypChip(name) {
    setFileChip(lypController, name, {
        idleLabel: "Load KLayout .lyp File",
        idleTitle: "Load a KLayout .lyp layer-properties file",
        unloadTitle: "Unload .lyp",
        onUnload: () => {
            modulePromise.then((Module) => {
                // Empty text clears g_lyp_info and reverts layers to hash colors.
                Module.loadLypText("");
                renderLayerList(Module.getLayers());
            });
            vscode.postMessage({ command: "unloadLypFile" });
            setLypChip(null);
        }
    });
}

function setMarkerChip(name) {
    setFileChip(markerController, name, {
        idleLabel: "Load Marker File (.lyrdb / DRC)",
        idleTitle: "Load a KLayout report database (.lyrdb) or Calibre DRC ASCII results database",
        unloadTitle: "Unload marker file",
        onUnload: () => {
            modulePromise.then((Module) => Module.clearMarkers());
            vscode.postMessage({ command: "unloadMarkerFile" });
            removeMarkerBrowser();
            currentMarkers = null;
            setMarkerChip(null);
        }
    });
}
setLypChip(null);
setMarkerChip(null);

let layersFolder = null;
// Every checkbox row and category folder currently in the panel. Kept because
// a flat checkbox list stops working somewhere around 20 layers and a real PDK
// has well over 100, so the panel needs to filter, solo and bulk-toggle -- and
// all four of those act on rows that already exist. Filtering in particular
// has to show and hide rows in place: destroying and re-adding a hundred
// lil-gui controllers on every keystroke is far too slow to type against.
let layerRows = [];
let layerCategories = [];
// Whether a filter query is currently narrowing the list, and each category's
// open/closed state from before it was -- typing opens every folder with a hit
// (the point of typing is to see the matches, not to then click nine folders
// open), and clearing the box has to put them back rather than leaving the
// whole list expanded.
let layerFilterActive = false;

// Which layer is soloed, plus the visibility of every layer at the moment it
// was. Solo is only reversible because of that snapshot: "show everything
// again" is a different and usually wrong answer, since most of a PDK's layer
// list is layers you had already turned off on purpose.
let soloTag = null;
let soloRestore = null;

function layerTag(item) {
    return `${item.layer}/${item.datatype}`;
}

// Compact count for a row ("1.2k", "3M") -- the exact number goes in the
// tooltip. A 260px panel has no room for seven digits per row.
function fmtCount(n) {
    if (n < 1000) return String(n);
    if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
    return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
}

// Tints a lil-gui row/folder's 4px left border with a layer's frame color --
// lil-gui has no built-in color swatch for booleans, so the border is the cue.
function tintBorder(el, color) {
    if (el) el.style.borderLeft = `4px solid ${color}`;
}

// Writes a row's visibility everywhere it's held: the checkbox's own state
// object, the checkbox on screen, and wasm. Deliberately not via the
// controller's setValue, which fires onChange -- that path is reserved for the
// user actually clicking the checkbox, which is what drops the solo snapshot.
function setRowVisible(Module, row, visible) {
    if (row.state.visible === visible) return;
    row.state.visible = visible;
    row.controller.updateDisplay();
    Module.setLayerVisible(row.item.layer, row.item.datatype, visible);
}

// Re-reads every layer row's checkbox from wasm. Needed by the paths that set
// visibility in bulk without going through the rows themselves -- restoring a
// saved view (see restoreNamedView) is one -- where the panel would otherwise
// keep showing the checkboxes of the state it replaced. The reverse of
// setRowVisible: wasm already holds the value, so this only catches the display
// up to it.
function syncLayerRowsFromModule(Module) {
    const visibleByTag = new Map();
    for (const layer of Module.getLayers()) {
        visibleByTag.set(`${layer.layer}/${layer.datatype}`, layer.visible);
    }
    for (const row of layerRows) {
        const visible = visibleByTag.get(layerTag(row.item));
        if (visible === undefined || row.state.visible === visible) continue;
        row.state.visible = visible;
        row.controller.updateDisplay();
    }
    syncCategoryChecks();
}

// Re-derives every category's "all" checkbox from the rows under it.
function syncCategoryChecks() {
    for (const category of layerCategories) {
        const all = category.rows.every((row) => row.state.visible);
        if (category.allState.visible !== all) {
            category.allState.visible = all;
            category.allController.updateDisplay();
        }
    }
}

// Drops the solo snapshot: any hand-set visibility makes it describe a state
// that no longer exists, and restoring to it would undo the change just made.
function forgetSolo() {
    if (soloTag === null) return;
    soloTag = null;
    soloRestore = null;
    markSoloRow();
}

function markSoloRow() {
    for (const row of layerRows) {
        row.controller.domElement.classList.toggle("layer-soloed", layerTag(row.item) === soloTag);
    }
}

// Show only this layer; clicking the same layer's S again puts back the
// visibility set the first click captured.
function toggleSolo(item) {
    const tag = layerTag(item);
    const restore = soloTag === tag ? soloRestore : null;
    if (restore) {
        soloTag = null;
        soloRestore = null;
    } else {
        soloRestore = new Map(layerRows.map((row) => [layerTag(row.item), row.state.visible]));
        soloTag = tag;
    }
    markSoloRow();
    modulePromise.then((Module) => {
        for (const row of layerRows) {
            const rowTag = layerTag(row.item);
            setRowVisible(Module, row, restore ? restore.get(rowTag) !== false : rowTag === tag);
        }
        syncCategoryChecks();
    });
}

// The All / None / Invert row. Scoped to whatever the filter is currently
// showing, which is what makes the pair worth having: filter to "metal", click
// None, and you've hidden one family without touching the other ninety layers.
function applyBulkVisibility(kind) {
    forgetSolo();
    const rows = layerRows.filter((row) => row.matches);
    modulePromise.then((Module) => {
        for (const row of rows) {
            setRowVisible(Module, row, kind === "invert" ? !row.state.visible : kind === "all");
        }
        syncCategoryChecks();
    });
}

// Narrows the list to rows whose number, datatype, name or category contains
// the query. Rows are hidden, not removed, so the visibility state behind them
// is untouched -- a filter is a view of the list, not an edit to it.
function applyLayerFilter(text) {
    const query = text.trim().toLowerCase();
    if (query && !layerFilterActive) {
        for (const category of layerCategories) {
            category.wasOpen = !category.folder.domElement.classList.contains("lil-closed");
        }
    }
    layerFilterActive = !!query;

    for (const row of layerRows) {
        row.matches = !query || row.haystack.includes(query);
        row.controller.domElement.style.display = row.matches ? "" : "none";
    }
    for (const category of layerCategories) {
        const matched = category.rows.reduce((n, row) => n + (row.matches ? 1 : 0), 0);
        category.folder.domElement.style.display = matched > 0 ? "" : "none";
        category.folder.title(query
            ? `${category.name}  (${matched} of ${category.rows.length})`
            : `${category.name}  (${category.rows.length})`);
        if (query) category.folder.open();
        else if (!category.wasOpen) category.folder.close();
    }
}

// Adds one visibility checkbox for a single (layer, datatype) item to `parent`,
// with its shape count and a solo button on the right. onSync (optional)
// refreshes the enclosing category's "all" checkbox after a toggle. Returns the
// row record the filter/solo/bulk paths above operate on.
function addLayerRow(parent, item, onSync) {
    const label = item.name
        ? `${item.layer}/${item.datatype} – ${item.name}`
        : `${item.layer}/${item.datatype}`;
    const shapes = item.polygonCount || 0;
    const labels = item.labelCount || 0;
    const state = { visible: item.visible };
    const controller = parent.add(state, "visible")
        .name(label)
        .onChange((visible) => {
            forgetSolo();
            modulePromise.then((Module) => Module.setLayerVisible(item.layer, item.datatype, visible));
            if (onSync) onSync();
        });
    tintBorder(controller.domElement, item.frameColor);
    controller.domElement.classList.add("layer-row");
    controller.domElement.title = [
        label,
        `${shapes.toLocaleString()} shape${shapes === 1 ? "" : "s"}, ` +
        `${labels.toLocaleString()} label${labels === 1 ? "" : "s"}`
    ].join("\n");

    const count = document.createElement("span");
    count.className = "layer-count";
    // A layer with no polygons at all but labels on it -- which real decks do
    // have -- would read as empty behind a bare "0", so those count their text
    // instead and say so with the same T the panel's text toggle uses.
    count.textContent = shapes > 0 ? fmtCount(shapes) : (labels > 0 ? `T${fmtCount(labels)}` : "0");

    const solo = document.createElement("span");
    solo.className = "layer-solo";
    solo.textContent = "S";
    solo.title = "Solo — hide every other layer (click again to restore them)";
    solo.addEventListener("click", (event) => {
        // lil-gui builds a boolean row as a <label> wrapping its checkbox, so
        // without this a click anywhere inside it -- here included -- would also
        // toggle the layer it's meant to solo.
        event.preventDefault();
        event.stopPropagation();
        toggleSolo(item);
    });
    controller.domElement.append(count, solo);

    return { controller, state, item, matches: true, haystack: `${label} ${item.group || ""}`.toLowerCase() };
}

// The two hand-built rows at the top of the Layers folder: a live filter box
// and All | None | Invert. Both are built by hand for the same reason the
// Pan | Measure row is -- lil-gui has neither a live-updating text field (its
// string controller only reports on Enter/blur, which is useless for a filter)
// nor a segmented control -- and both reuse its row classes so they pick up the
// panel's metrics and theme for free.
function addLayerListControls(folder) {
    const filterRow = document.createElement("div");
    filterRow.className = "lil-controller layer-filter-row";
    const filterName = document.createElement("div");
    filterName.className = "lil-name";
    filterName.textContent = "Filter";
    const filterWidget = document.createElement("div");
    filterWidget.className = "lil-widget";
    const filterInput = document.createElement("input");
    filterInput.type = "text";
    filterInput.placeholder = "number, name or group";
    filterInput.addEventListener("input", () => applyLayerFilter(filterInput.value));
    filterWidget.appendChild(filterInput);
    filterRow.append(filterName, filterWidget);
    filterRow.title = "Show only layers whose number, datatype, name or group contains this";

    const bulkRow = document.createElement("div");
    bulkRow.className = "lil-controller mode-row layer-bulk-row";
    const bulkName = document.createElement("div");
    bulkName.className = "lil-name";
    bulkName.textContent = "Show";
    const bulkWidget = document.createElement("div");
    bulkWidget.className = "lil-widget mode-widget";
    const BULK = [
        { id: "all", label: "All", title: "Show every layer the filter is showing" },
        { id: "none", label: "None", title: "Hide every layer the filter is showing" },
        { id: "invert", label: "Invert", title: "Flip every filtered layer's visibility" }
    ];
    for (const action of BULK) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = action.label;
        btn.title = action.title;
        btn.addEventListener("click", () => applyBulkVisibility(action.id));
        bulkWidget.appendChild(btn);
    }
    bulkRow.append(bulkName, bulkWidget);

    folder.$children.append(filterRow, bulkRow);
}

// Rebuilds the layer folder from Module.getLayers() -- {layer, datatype, name,
// group, fillColor, frameColor, visible}[], all plain scalars/strings (no
// per-polygon geometry crosses into JS). Layers are keyed on the (layer,
// datatype) pair and organized into collapsible categories from the .lyp's
// top-level groups (`group`, e.g. "Metals"): each category folder has an "all"
// checkbox that toggles every layer under it, plus one checkbox per
// layer/datatype. Layers with no category (ungrouped, or present in the GDS but
// absent from the .lyp) go under "Other layers". Called after every
// load/loadLypText() since either can change the layer set, colors, or
// visibility.
function renderLayerList(layers) {
    if (layersFolder) {
        layersFolder.destroy();
    }
    layerRows = [];
    layerCategories = [];
    layerFilterActive = false;
    // The snapshot describes the layer set that's being thrown away, so it
    // can't survive into the next one.
    soloTag = null;
    soloRestore = null;

    // lil-gui folders open by default (dat.gui's were closed) -- keep the
    // panel compact until the user asks for the layer list.
    layersFolder = gui.addFolder("Layers");
    layersFolder.close();
    addLayerListControls(layersFolder);

    // Group by category, preserving getLayers()'s ordering (lyp order first).
    // Ungrouped layers collect under a single trailing "Other layers" bucket.
    const OTHER = "Other layers";
    const categories = new Map();
    for (const layer of layers) {
        const key = layer.group || OTHER;
        if (!categories.has(key)) categories.set(key, []);
        categories.get(key).push(layer);
    }

    for (const [category, items] of categories) {
        const folder = layersFolder.addFolder(`${category}  (${items.length})`);
        folder.close();
        // The folder's own <div.lil-gui> (title + children) carries a 4px
        // border too.
        tintBorder(folder.domElement, items[0].frameColor);

        const children = [];
        const syncCategory = () => {
            const all = children.every((c) => c.state.visible);
            if (allState.visible !== all) {
                allState.visible = all;
                allController.updateDisplay();
            }
        };
        const allState = { visible: items.every((it) => it.visible) };
        const allController = folder.add(allState, "visible")
            .name("◼ all")
            .onChange((visible) => {
                forgetSolo();
                modulePromise.then((Module) => {
                    for (const c of children) setRowVisible(Module, c, visible);
                });
            });
        allController.domElement.title = `Toggle all ${items.length} layers in ${category}`;

        const shapeTotal = items.reduce((n, it) => n + (it.polygonCount || 0), 0);
        folder.$title.title = `${category}: ${items.length} layer${items.length === 1 ? "" : "s"}, ` +
                              `${shapeTotal.toLocaleString()} shape${shapeTotal === 1 ? "" : "s"}`;

        for (const item of items) {
            children.push(addLayerRow(folder, item, syncCategory));
        }
        layerRows.push(...children);
        layerCategories.push({ name: category, folder, rows: children, allState, allController, wasOpen: false });
    }
}

// ---- Hierarchy tree (left panel) ----
// The design's cell tree, as parseGdsToLayers hands it back (see
// build_hierarchy in renderer.cpp): a flat cells[] array of
// {name, polygons, labels, bbox, refs} plus the indices of the top-level
// cells, where each ref is {cell, count, bbox, xform} -- one entry per
// distinct cell a parent places, however many times it places it.
//
// Rows are built lazily, only when a branch is opened: cells[] describes each
// cell once, but the tree it spans is the expansion of a DAG, so a mid-sized
// chip's fully materialized tree is far larger than its library -- and nobody
// reads more than the few branches they opened.
const hierarchyPanel = document.getElementById("hierarchyPanel");
const hierarchyTree = document.getElementById("hierarchyTree");
const hierarchyCount = document.getElementById("hierarchyCount");
const hierarchyHide = document.getElementById("hierarchyHide");
const hierarchyShowBtn = document.getElementById("hierarchyShowBtn");

let hierarchyModel = null;
// Open branches and the selected row are keyed by their path of cell names
// ("TOP/PIXEL/TAP"), not by DOM node: a reload throws every row away, and a
// path still identifies the same branch in the re-read file, so an edit-and-
// reload lands back where you were rather than collapsed to the roots.
const hierarchyExpanded = new Set();
let hierarchySelectedPath = null;
let hierarchySelectedRow = null;
// The selected row's world-space boxes, one per placement it stands for (empty
// for a cell with no geometry), kept so the canvas outlines can be re-pushed
// whenever the panel opens or closes -- see syncCellHighlight.
let hierarchySelectedBoxes = [];
// Which design the state above belongs to, so opening a different file starts
// from a clean tree instead of inheriting another design's open branches.
let hierarchyRootKey = null;
// Set once the user hides or shows the panel by hand; from then on that
// decision wins over the default below on every subsequent load.
let hierarchyUserChoice = null;
// Mirrors kMaxHierarchyDepth in renderer.cpp. References form a DAG in any
// valid file, so this only bites a malformed one that closes a loop -- where a
// branch could otherwise be opened without end.
const HIERARCHY_MAX_DEPTH = 256;

// [a, b, c, d, tx, ty] laid out as renderer.cpp's Affine2D: x' = a*x + b*y + tx,
// y' = c*x + d*y + ty.
const HIERARCHY_IDENTITY = [1, 0, 0, 1, 0, 0];

// compose(outer, inner) applied to a point == outer applied to inner applied
// to it (the JS twin of compose_affine in renderer.cpp).
function composeXform(outer, inner) {
    return [
        outer[0] * inner[0] + outer[1] * inner[2],
        outer[0] * inner[1] + outer[1] * inner[3],
        outer[2] * inner[0] + outer[3] * inner[2],
        outer[2] * inner[1] + outer[3] * inner[3],
        outer[0] * inner[4] + outer[1] * inner[5] + outer[4],
        outer[2] * inner[4] + outer[3] * inner[5] + outer[5]
    ];
}

// A box mapped through a transform, as the box of its four mapped corners --
// an over-estimate under a non-90° rotation, same as the wasm side's
// placed_box, and for framing the camera that's immaterial.
function transformBox(m, box) {
    const corners = [[box.minX, box.minY], [box.maxX, box.minY], [box.minX, box.maxY], [box.maxX, box.maxY]];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of corners) {
        const wx = m[0] * x + m[1] * y + m[4];
        const wy = m[2] * x + m[3] * y + m[5];
        minX = Math.min(minX, wx);
        maxX = Math.max(maxX, wx);
        minY = Math.min(minY, wy);
        maxY = Math.max(maxY, wy);
    }
    return { minX, maxX, minY, maxY };
}

// The boxes to outline for one tree node: one per placement the row stands for.
// A row is a cell *as one parent places it*, so a cell placed 40 times is 40
// separate rectangles where the copies actually sit -- the box spanning all 40
// (which is what the row frames the camera on) mostly encloses other cells'
// geometry, and drawing that instead says the selected cell is everything in it.
//
// Each placement transform maps the child's own frame into the parent's, so its
// world box is the child cell's own box carried through the placement and then
// through the parent's transform. Rows over the tree's placement cap (see
// kMaxRowPlacements in renderer.cpp) carry no transforms; those fall back to the
// spanning box, since a partial set of copies is worse than an honest envelope.
function hierarchyBoxes(node, cell, parentXform, spanningBox) {
    const placements = node.placements;
    if (!placements || placements.length < 6 || !cell.bbox) {
        return spanningBox ? [spanningBox] : [];
    }
    const boxes = [];
    for (let i = 0; i + 5 < placements.length; i += 6) {
        const xform = composeXform(parentXform, [
            placements[i], placements[i + 1], placements[i + 2],
            placements[i + 3], placements[i + 4], placements[i + 5]
        ]);
        boxes.push(transformBox(xform, cell.bbox));
    }
    return boxes;
}

// Shows/hides the panel. byUser marks the entry points the user drives (the
// header's ✕, the reopen button, the H key), which is what makes the choice
// stick across loads.
function setHierarchyOpen(open, byUser) {
    if (byUser) hierarchyUserChoice = open;
    if (hierarchyPanel) hierarchyPanel.classList.toggle("hidden", !open);
    document.body.classList.toggle("hierarchy-open", open);
    // The outline belongs to the panel: it's the tree pointing at the layout,
    // so with the tree away it would be a dashed rectangle with nothing on
    // screen to explain it. Putting the panel away takes it down, and bringing
    // the panel back puts it up again for whatever row is still selected.
    syncCellHighlight();
}

// Pushes the canvas outlines the current state calls for: the selected row's
// boxes while the panel is open, nothing otherwise. Every change to either half
// of that -- the selection, the panel's visibility -- goes through here rather
// than calling into wasm directly, so the two can't disagree.
function syncCellHighlight() {
    const open = hierarchyPanel && !hierarchyPanel.classList.contains("hidden");
    const boxes = open ? hierarchySelectedBoxes : null;
    modulePromise.then((Module) => {
        if (!boxes || boxes.length === 0) {
            Module.clearCellHighlight();
            return;
        }
        // Flat [minX, minY, maxX, maxY, ...] -- one bulk conversion in wasm
        // rather than a call (and a JS object read) per placement.
        const flat = [];
        for (const box of boxes) flat.push(box.minX, box.minY, box.maxX, box.maxY);
        Module.setCellHighlight(flat);
    });
}

// Marks a row selected: the row itself in the panel, and -- via `boxes`, the
// placements the row stands for (see hierarchyBoxes) -- an outline around each
// copy of that cell on the canvas. The outlines are the half that survives
// navigating away: framing a cell says which shapes it is only until the view
// moves, whereas the boxes stay glued to the geometry, so zooming out to see
// where the cell sits in the design keeps the answer instead of losing it. Cells
// with no geometry pass no boxes and draw nothing -- there's no region to point
// at.
function hierarchySelect(row, path, boxes) {
    if (hierarchySelectedRow) hierarchySelectedRow.classList.remove("hier-selected");
    hierarchySelectedRow = row;
    hierarchySelectedPath = path;
    hierarchySelectedBoxes = boxes || [];
    row.classList.add("hier-selected");
    syncCellHighlight();
}

// Drops the selection entirely (Escape, and every path that replaces the tree).
// hierarchySelectedPath is cleared too, so a rebuild doesn't re-select it.
function hierarchyDeselect() {
    if (hierarchySelectedRow) hierarchySelectedRow.classList.remove("hier-selected");
    hierarchySelectedRow = null;
    hierarchySelectedPath = null;
    hierarchySelectedBoxes = [];
    syncCellHighlight();
}

function hierarchyTooltip(cell, node, box, boxes) {
    const lines = [cell.name];
    if (node.count > 1) {
        // Only the first copy is walked into, so say so on the row rather than
        // leaving "expand" and "×64" to look like a contradiction. Whether the
        // copies are outlined one by one or covered by a single box is a visible
        // difference on screen, so the row says which it is.
        const each = boxes.length > 1 ? "each outlined" : "outlined as one box, too many to mark separately";
        lines.push(`${node.count} placements here, ${each} (expanding follows the first)`);
    }
    lines.push(`${cell.polygons} own shape${cell.polygons === 1 ? "" : "s"}, ` +
               `${cell.labels} label${cell.labels === 1 ? "" : "s"}, ` +
               `${cell.refs.length} child cell${cell.refs.length === 1 ? "" : "s"}`);
    if (box) {
        lines.push(`${fmtCoord(box.maxX - box.minX)} × ${fmtCoord(box.maxY - box.minY)} µm ` +
                   `at (${fmtCoord((box.minX + box.maxX) / 2)}, ${fmtCoord((box.minY + box.maxY) / 2)}) — ` +
                   `click to zoom to it and outline it (Esc clears)`);
    } else {
        lines.push("empty — no geometry to zoom to");
    }
    return lines.join("\n");
}

// Appends a row per entry of `nodes` (ref entries, or the synthetic root
// entries built in renderHierarchy) to `container`.
//
// parentXform maps the parent cell's own coordinates into world space, so a
// node's world box is its bbox -- which is in the parent's frame, spanning
// every placement the entry stands for -- mapped through it. Descending
// instead composes the entry's own xform, the *first* placement's: a cell
// placed 64 times is one row that frames all 64, and opening it walks into one
// of them, because there is no single deeper coordinate frame to offer. The
// per-placement boxes (what selecting the row outlines) are the other side of
// that same collapse -- see hierarchyBoxes.
function addHierarchyRows(container, nodes, depth, parentPath, parentXform) {
    for (const node of nodes) {
        const cell = hierarchyModel.cells[node.cell];
        if (!cell) continue;

        const path = parentPath ? `${parentPath}/${cell.name}` : cell.name;
        const box = node.bbox ? transformBox(parentXform, node.bbox) : null;
        const boxes = hierarchyBoxes(node, cell, parentXform, box);
        const childXform = composeXform(parentXform, node.xform);
        const expandable = cell.refs.length > 0 && depth + 1 < HIERARCHY_MAX_DEPTH;

        const row = document.createElement("div");
        row.className = "hier-row";
        row.style.paddingLeft = `${6 + depth * 12}px`;
        if (!box) row.classList.add("hier-boxless");

        const twisty = document.createElement("span");
        twisty.className = "hier-twisty";
        twisty.textContent = expandable ? "▸" : "";
        const name = document.createElement("span");
        name.className = "hier-name";
        name.textContent = cell.name;
        const count = document.createElement("span");
        count.className = "hier-count";
        if (node.count > 1) count.textContent = `×${node.count}`;
        row.append(twisty, name, count);
        row.title = hierarchyTooltip(cell, node, box, boxes);

        const children = document.createElement("div");
        children.className = "hier-children hidden";
        container.append(row, children);

        let built = false;
        function setExpanded(open) {
            if (!expandable) return;
            if (open && !built) {
                built = true;
                addHierarchyRows(children, cell.refs, depth + 1, path, childXform);
            }
            children.classList.toggle("hidden", !open);
            twisty.textContent = open ? "▾" : "▸";
            if (open) hierarchyExpanded.add(path);
            else hierarchyExpanded.delete(path);
        }

        twisty.addEventListener("click", (event) => {
            // The twisty sits inside the row, whose own click moves the
            // camera -- opening a branch shouldn't also fly the view there.
            event.stopPropagation();
            setExpanded(children.classList.contains("hidden"));
        });
        row.addEventListener("click", () => {
            // Selection outlines every placement; the camera still frames all of
            // them at once, since that's the one view that shows the row's whole
            // meaning.
            hierarchySelect(row, path, boxes);
            if (!box) return;
            modulePromise.then((Module) => Module.zoomToBox(box.minX, box.minY, box.maxX, box.maxY));
        });

        // Re-selecting after a rebuild (a reload, or reopening a branch) puts
        // the outlines back without moving the camera -- only a click moves it.
        if (path === hierarchySelectedPath) hierarchySelect(row, path, boxes);
        // ...except a rebuild the search asked for, which is standing in for the
        // click the user would have made if the row had been on screen: that one
        // frames the cell and scrolls the row it made to it (see revealCell).
        if (path === hierarchyRevealPath) {
            row.scrollIntoView({ block: "center" });
            if (box) modulePromise.then((Module) => Module.zoomToBox(box.minX, box.minY, box.maxX, box.maxY));
        }
        if (hierarchyExpanded.has(path)) setExpanded(true);
    }
}

// Path the search asked to reveal, consumed by addHierarchyRows as it builds
// that row (see revealCell). Null at every other moment, so a rebuild for any
// other reason moves nothing.
let hierarchyRevealPath = null;

// Throws the rows away and builds them again from the current model, keeping
// the open branches and the selection (both are held by path, not by DOM node
// -- see hierarchyExpanded). Rebuilding rather than reaching into the rows is
// what makes revealing a cell possible at all: a row for a branch nobody has
// opened doesn't exist yet, and adding the branch's path to hierarchyExpanded
// and building again is how it comes to.
function rebuildHierarchyRows() {
    if (!hierarchyTree || !hierarchyModel) return;
    hierarchySelectedRow = null;
    hierarchySelectedBoxes = [];
    hierarchyTree.textContent = "";

    const cells = hierarchyModel.cells || [];
    const roots = (hierarchyModel.roots || []).filter((index) => cells[index]);
    // Top-level cells are drawn as if referenced once by an invisible parent
    // at the identity transform -- their own coordinates *are* world
    // coordinates, which is exactly what that entry says.
    const rootNodes = roots.map((index) => ({
        cell: index,
        count: 1,
        bbox: cells[index].bbox,
        xform: HIERARCHY_IDENTITY
    }));
    addHierarchyRows(hierarchyTree, rootNodes, 0, "", HIERARCHY_IDENTITY);
}

// The tree's half of a cell search: cellPathToTarget (cell-search.js, loaded
// via its own <script> tag) finds the path, and revealCell below opens it.
function hierarchyPathToCell(target) {
    if (!hierarchyModel) return null;
    return cellPathToTarget(hierarchyModel.cells || [], hierarchyModel.roots || [],
                            target, HIERARCHY_MAX_DEPTH);
}

// Opens the tree down to a cell, selects the row and frames it -- what clicking
// that row would have done, for a row that wasn't on screen to click. False
// means no top cell places this one (a reference cycle, or a cell the tree's
// own caps left out), so there is no branch to open.
function revealCell(target) {
    const path = hierarchyPathToCell(target);
    if (!path) return false;

    const names = path.map((index) => hierarchyModel.cells[index].name);
    // Every ancestor of the target row has to be open for it to exist, and
    // rows are keyed by the path of names leading to them.
    for (let i = 1; i < names.length; i++) {
        hierarchyExpanded.add(names.slice(0, i).join("/"));
    }
    hierarchySelectedPath = names.join("/");
    hierarchyRevealPath = hierarchySelectedPath;
    try {
        rebuildHierarchyRows();
    } finally {
        // Cleared even if a row throws mid-build, so a later rebuild for some
        // unrelated reason can't jump the camera at a stale path.
        hierarchyRevealPath = null;
    }
    return true;
}

// Rebuilds the tree from a freshly loaded design (or clears it, for model
// null -- a load that failed has no hierarchy to browse).
function renderHierarchy(model) {
    if (!hierarchyTree) return;
    hierarchyModel = model;
    // Every row is about to be thrown away. The selected *path* is kept -- the
    // rows rebuilt below re-select it, which puts the canvas outlines back at
    // the reloaded file's coordinates -- but the boxes themselves are dropped
    // first: if this design has no cell on that path, nothing else would.
    hierarchySelectedRow = null;
    hierarchySelectedBoxes = [];
    syncCellHighlight();
    hierarchyTree.textContent = "";

    const cells = (model && model.cells) || [];
    // Filtered once here so everything below can index cells[] freely -- the
    // omitted case ships no cells at all, and a root that names no cell would
    // otherwise throw somewhere less obvious.
    const roots = ((model && model.roots) || []).filter((index) => cells[index]);
    const cellCount = model ? model.cellCount : 0;

    // .hierarchy-available says there's a tree to show, open or not, which is
    // what the stale banner's left edge keys off (the reopen button sits in
    // the same corner it starts in).
    document.body.classList.toggle("hierarchy-available", cellCount > 0);

    if (!model || cellCount === 0) {
        if (hierarchyCount) hierarchyCount.textContent = "";
        if (hierarchyShowBtn) hierarchyShowBtn.classList.add("hidden");
        refreshFind(true);
        setHierarchyOpen(false);
        return;
    }
    if (hierarchyShowBtn) hierarchyShowBtn.classList.remove("hidden");
    if (hierarchyCount) hierarchyCount.textContent = `${cellCount} cell${cellCount === 1 ? "" : "s"}`;

    // A different design: drop the previous one's open branches and selection
    // rather than matching them against unrelated cell names.
    const rootKey = roots.map((i) => cells[i].name).join(" ");
    const sameDesign = rootKey === hierarchyRootKey;
    if (!sameDesign) {
        hierarchyRootKey = rootKey;
        hierarchyExpanded.clear();
        hierarchySelectedPath = null;
    }
    // The find box follows the same rule: a reload of the same design keeps the
    // query and re-runs it over what was just read -- a search in progress is
    // part of the working context a reload preserves, alongside the camera and
    // the open branches -- while a different design starts from an empty box.
    refreshFind(!sameDesign);

    if (model.omitted) {
        const note = document.createElement("div");
        note.className = "hier-note";
        note.textContent = `This design has ${cellCount} cells — too many to browse as a tree, so it isn't built.`;
        hierarchyTree.append(note);
        setHierarchyOpen(hierarchyUserChoice === true);
        return;
    }

    // First look at a design: open the top cell, so the panel shows what it's
    // made of instead of a single row you have to click to learn anything.
    if (hierarchyExpanded.size === 0 && roots.length > 0) {
        hierarchyExpanded.add(cells[roots[0]].name);
    }

    rebuildHierarchyRows();

    // Closed by default: the viewport belongs to the layout, and a panel that
    // takes 260px of it should be something you ask for. The rows above are
    // built either way -- they're what makes reopening instant -- and once the
    // panel has been opened by hand it stays open for the rest of the session,
    // including across reloads and other files.
    setHierarchyOpen(hierarchyUserChoice === true);
}

// Both the ✕ and the reopen button are the user speaking, as is the H key
// below -- all three go through here so the choice sticks.
function toggleHierarchy() {
    // Nothing loaded (or nothing to show): don't open an empty panel.
    if (!hierarchyPanel || !hierarchyModel || !hierarchyModel.cellCount) return;
    setHierarchyOpen(hierarchyPanel.classList.contains("hidden"), true);
}

if (hierarchyHide) {
    hierarchyHide.addEventListener("click", () => setHierarchyOpen(false, true));
}
if (hierarchyShowBtn) {
    hierarchyShowBtn.addEventListener("click", () => setHierarchyOpen(true, true));
}

// ---- Find: cells and labels ----
// One box over the two things in a design that have names: its cells, and the
// layout's own TEXT labels. Both answer the same question -- "where is the
// thing called X" -- so they share a box, a result list and a keystroke, with
// the scope pair saying which name is being matched.
//
// Results take the tree's place while a query is up, rather than filtering the
// rows the way the Layers panel filters its list: the tree is built lazily, so
// a cell in a branch nobody has opened has no row to show or hide. That is
// also why choosing a cell *reveals* it -- opens the branches down to it and
// selects the row (see revealCell) -- instead of just moving the camera and
// leaving the tree pointing somewhere else entirely.
const hierarchyFindToggle = document.getElementById("hierarchyFindToggle");
const hierarchyFindTwisty = document.getElementById("hierarchyFindTwisty");
const hierarchySearchBox = document.getElementById("hierarchySearch");
const hierarchySearchInput = document.getElementById("hierarchySearchInput");
const hierarchySearchCount = document.getElementById("hierarchySearchCount");
const hierarchyResults = document.getElementById("hierarchyResults");
const hierarchyScopeCells = document.getElementById("hierarchyScopeCells");
const hierarchyScopeLabels = document.getElementById("hierarchyScopeLabels");

// Rows past this aren't built. A 260px list is read, not scrolled through by
// the thousand, and the count line says how many matches were left out -- the
// same bargain the marker browser's per-category cap makes.
const MAX_FIND_ROWS = 200;

// Half-width of the box a chosen label is marked with, in pixels at the zoom it
// was chosen at. A label has no extent of its own -- its glyphs are drawn at a
// fixed pixel size, so there is no world-space box to frame -- which is also
// why choosing one pans without zooming: how much around it you want to see
// isn't something the label says (the same reasoning as Go to Coordinate).
const LABEL_MARK_PX = 14;

// "cells" or "labels".
let findScope = "cells";
// The query the list on screen belongs to, so an answer for a query already
// typed past can't overwrite a newer one.
let findQuery = "";
// One record per built row: {element, activate}. Also what the arrow keys walk.
let findRows = [];
let findActiveIndex = -1;

// Opens and closes the fold the box lives in (closed on arrival -- see the
// markup in viewer.html). Closing clears the query rather than just hiding the
// box: a result list is the answer to a question the panel would no longer be
// showing, and leaving one up with nothing on screen to explain it is the same
// mistake as leaving cell outlines up with the panel away.
function setFindOpen(open) {
    if (!hierarchySearchBox) return;
    const changed = open !== findIsOpen();
    hierarchySearchBox.classList.toggle("hidden", !open);
    if (hierarchyFindTwisty) hierarchyFindTwisty.textContent = open ? "▾" : "▸";

    if (open) {
        // Opening it is asking to type in it -- and so is asking for it again
        // when it's already out (which is what "/" does, see focusFindBox).
        if (hierarchySearchInput) hierarchySearchInput.focus();
        return;
    }
    // Only on the way down, so closing an already-closed box can't wipe a
    // query. Nothing does that today, but runSearch below is not free on a
    // design with a million labels.
    if (!changed) return;
    if (hierarchySearchInput) {
        hierarchySearchInput.value = "";
        hierarchySearchInput.blur();
    }
    runSearch();
}

function findIsOpen() {
    return !!(hierarchySearchBox && !hierarchySearchBox.classList.contains("hidden"));
}

// The list and the tree are the same slot in the panel.
function setFindResultsOpen(open) {
    if (!hierarchyResults || !hierarchyTree) return;
    hierarchyResults.classList.toggle("hidden", !open);
    hierarchyTree.classList.toggle("hidden", open);
}

function setFindCount(text) {
    if (hierarchySearchCount) hierarchySearchCount.textContent = text;
}

function clearFindRows() {
    if (hierarchyResults) hierarchyResults.textContent = "";
    findRows = [];
    findActiveIndex = -1;
}

// A line of prose in the list: no matches, or how many were left out.
function findNote(text) {
    if (!hierarchyResults) return;
    const note = document.createElement("div");
    note.className = "find-note";
    note.textContent = text;
    hierarchyResults.append(note);
}

// One result row: `name` on the left, `meta` on the right, `activate(row)` on
// click or Enter. Rows are appended in the order they're built, which is the
// order the arrow keys walk them in.
function addFindRow(name, meta, title, activate) {
    if (!hierarchyResults) return;
    const element = document.createElement("div");
    element.className = "find-row";
    const nameEl = document.createElement("span");
    nameEl.className = "find-name";
    nameEl.textContent = name;
    const metaEl = document.createElement("span");
    metaEl.className = "find-meta";
    metaEl.textContent = meta;
    element.append(nameEl, metaEl);
    element.title = title;
    const index = findRows.length;
    element.addEventListener("click", () => activateFindRow(index));
    hierarchyResults.append(element);
    findRows.push({ element, activate });
}

function setFindActive(index) {
    const previous = findRows[findActiveIndex];
    if (previous) previous.element.classList.remove("find-active");
    findActiveIndex = index;
    const row = findRows[index];
    if (!row) return;
    row.element.classList.add("find-active");
    row.element.scrollIntoView({ block: "nearest" });
}

function activateFindRow(index) {
    const row = findRows[index];
    if (!row || !row.activate) return;
    setFindActive(index);
    row.activate(row);
}

// Arrow keys walk the list and Enter takes the row they're on (the first, if
// they haven't been used): a list you can only reach with the mouse makes you
// let go of the keyboard you just typed the query with.
function stepFindRow(direction) {
    if (findRows.length === 0) return;
    const from = findActiveIndex < 0 ? (direction > 0 ? -1 : 0) : findActiveIndex;
    setFindActive((from + direction + findRows.length) % findRows.length);
}

// Re-runs the search from whatever is in the box: every keystroke, a scope
// switch, and each load.
function runSearch() {
    if (!hierarchySearchInput) return;
    const query = hierarchySearchInput.value.trim();
    findQuery = query;
    if (!query) {
        clearFindRows();
        setFindResultsOpen(false);
        setFindCount("");
        return;
    }
    setFindResultsOpen(true);
    if (findScope === "labels") runLabelSearch(query);
    else renderCellResults(query);
}

function renderCellResults(query) {
    clearFindRows();
    // A design too large for a tree ships no cell names at all (see the
    // omitted case in build_hierarchy), so there is nothing here to match --
    // say which of the two it is rather than answering "no such cell".
    if (hierarchyModel && hierarchyModel.omitted) {
        setFindCount("");
        findNote(`This design's ${hierarchyModel.cellCount} cells are too many for the viewer to hold as a tree, ` +
                 `so it has no cell names to search. Labels still work.`);
        return;
    }

    const cells = (hierarchyModel && hierarchyModel.cells) || [];
    // Best match first -- see rankCellMatches in cell-search.js.
    const matches = rankCellMatches(cells, query);

    setFindCount(matches.length === 0
        ? "no match"
        : `${Math.min(matches.length, MAX_FIND_ROWS)} of ${matches.length} cell${matches.length === 1 ? "" : "s"}`);

    for (const index of matches.slice(0, MAX_FIND_ROWS)) {
        const cell = cells[index];
        // Same shorthand the layer rows use: a cell whose own content is text
        // rather than geometry would otherwise read as empty behind a bare 0.
        const meta = cell.polygons > 0
            ? fmtCount(cell.polygons)
            : (cell.labels > 0 ? `T${fmtCount(cell.labels)}` : "0");
        const title = [
            cell.name,
            `${cell.polygons.toLocaleString()} own shape${cell.polygons === 1 ? "" : "s"}, ` +
            `${cell.labels.toLocaleString()} label${cell.labels === 1 ? "" : "s"}, ` +
            `${cell.refs.length} child cell${cell.refs.length === 1 ? "" : "s"}`,
            "Click to open the tree down to it, frame it and outline every placement"
        ].join("\n");
        addFindRow(cell.name, meta, title, (row) => chooseCell(index, row));
    }
    if (matches.length > MAX_FIND_ROWS) {
        findNote(`… ${matches.length - MAX_FIND_ROWS} more — narrow the query`);
    }
    if (matches.length === 0) findNote(`No cell name contains “${query}”.`);
}

// The answer to "where is this cell" is a row in the hierarchy, in context and
// with its parents opened -- so the tree is what's on screen afterwards, and
// the list steps aside. The query stays in the box: clicking back into it
// brings the same list back without retyping.
function chooseCell(index, row) {
    // The tree goes back on screen *before* the row is built, not after:
    // revealCell scrolls the row it makes into view, and an element inside a
    // display:none container has nowhere to be scrolled to.
    setFindResultsOpen(false);
    if (revealCell(index)) return;

    // No top cell places this one, so there's no branch to open down to it.
    // Said on the row that was clicked rather than as a message elsewhere --
    // which means bringing the list back to say it -- and the row goes inert so
    // it doesn't invite a second try.
    setFindResultsOpen(true);
    row.activate = null;
    row.element.classList.add("find-unreachable");
    row.element.title = `${hierarchyModel.cells[index].name}\n` +
        `No top cell places this one, so the tree has no branch that reaches it.`;
}

// Labels live in wasm and never cross back (a full chip's worth of them is far
// too much to hold twice), so the match itself happens there -- see findLabels
// in renderer.cpp, which also reports how many matched beyond the ones it
// returned.
function runLabelSearch(query) {
    modulePromise.then((Module) => {
        const result = Module.findLabels(query, MAX_FIND_ROWS);
        // The box may have moved on while this was in flight.
        if (query !== findQuery || findScope !== "labels") return;
        renderLabelResults(query, result);
    });
}

function renderLabelResults(query, result) {
    clearFindRows();
    const hits = result.hits || [];
    const total = result.total || 0;
    setFindCount(total === 0
        ? "no match"
        : `${hits.length} of ${total.toLocaleString()} label${total === 1 ? "" : "s"}`);

    for (const hit of hits) {
        const tag = hit.name ? `${hit.layer}/${hit.datatype} ${hit.name}` : `${hit.layer}/${hit.datatype}`;
        // Hidden layers are searched too -- the label you're looking for is
        // often on one you turned off -- so the row says when that's the case
        // rather than sending you to a spot with nothing on it.
        const meta = hit.visible ? tag : `${tag} · hidden`;
        const title = [
            hit.text,
            `on layer ${tag}${hit.visible ? "" : " — currently hidden, but the label is still marked"}`,
            `at (${fmtCoord(hit.x)}, ${fmtCoord(hit.y)}) µm — click to pan there and mark it`
        ].join("\n");
        addFindRow(hit.text, meta, title, () => goToLabel(hit));
    }
    if (total > hits.length) {
        findNote(`… ${(total - hits.length).toLocaleString()} more — narrow the query`);
    }
    if (total === 0) findNote(`No label text contains “${query}”.`);
}

// Pans to a label and marks it. The list stays up, unlike the cell case: each
// row here is a candidate to look at, and stepping through them is a series of
// camera moves, not a change of what the panel is showing.
function goToLabel(hit) {
    modulePromise.then((Module) => {
        Module.goToPoint(hit.x, hit.y);
        // The layout's own labels are only drawn with the Text toggle on, and
        // it's off by default -- landing on a label and showing nothing is the
        // wrong end to a search, so finding one turns text on rather than
        // explaining why it isn't there. setValue (not the bare flag) so the
        // checkbox and wasm both follow.
        if (!actions.showText) textController.setValue(true);
        markLabelHit(Module, hit);
    });
}

// The mark goes in the panel's highlight channel -- the same one a selected
// cell's outlines use -- so Esc takes it down, hiding the panel takes it with
// it, and pointing at one thing stops pointing at the other. The panel points
// at one place at a time, so the tree's selection is dropped here rather than
// left highlighted somewhere off screen.
function markLabelHit(Module, hit) {
    const zoom = Module.getCamera().zoom;
    const half = LABEL_MARK_PX / (zoom > 0 ? zoom : 1);
    if (hierarchySelectedRow) hierarchySelectedRow.classList.remove("hier-selected");
    hierarchySelectedRow = null;
    hierarchySelectedPath = null;
    hierarchySelectedBoxes = [{
        minX: hit.x - half,
        minY: hit.y - half,
        maxX: hit.x + half,
        maxY: hit.y + half
    }];
    syncCellHighlight();
}

function setFindScope(scope) {
    if (findScope === scope) return;
    findScope = scope;
    updateFindScope();
    runSearch();
}

// Reflects the scope pair and the box's placeholder, including the case where
// one side has nothing to search (see renderCellResults).
function updateFindScope() {
    const cellsAvailable = !!(hierarchyModel && !hierarchyModel.omitted &&
                              hierarchyModel.cells && hierarchyModel.cells.length > 0);
    if (hierarchyScopeCells) {
        hierarchyScopeCells.classList.toggle("scope-active", findScope === "cells");
        hierarchyScopeCells.disabled = !cellsAvailable;
        hierarchyScopeCells.title = cellsAvailable
            ? "Search the design's cell names"
            : "This design's cell names aren't held in the viewer — see the note in the panel";
    }
    if (hierarchyScopeLabels) {
        hierarchyScopeLabels.classList.toggle("scope-active", findScope === "labels");
    }
    if (hierarchySearchInput) {
        hierarchySearchInput.placeholder = findScope === "labels" ? "label text" : "cell name";
    }
}

// Called for every load (see renderHierarchy). `reset` empties the box; either
// way whatever query is left is re-run, since both haystacks have just been
// replaced by the file that was read. A design with no cell tree has nothing to
// search by cell name, so the scope moves to the side that can still answer
// rather than leaving a box that returns nothing whatever you type.
function refreshFind(reset) {
    if (reset && hierarchySearchInput) hierarchySearchInput.value = "";
    if (hierarchyModel && hierarchyModel.omitted) findScope = "labels";
    updateFindScope();
    runSearch();
}

if (hierarchySearchInput) {
    hierarchySearchInput.addEventListener("input", runSearch);
    // Choosing a cell puts the list away; clicking back into the box is how it
    // comes back, without retyping the query it still holds.
    hierarchySearchInput.addEventListener("focus", () => {
        if (findQuery) setFindResultsOpen(true);
    });
    hierarchySearchInput.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            // Escape in a search box undoes the search, and only leaves the box
            // once there's no query left to undo. Stopped here either way, so it
            // never reaches the window handler's Escape -- which takes rulers
            // and outlines off the canvas, and has nothing to do with typing.
            if (hierarchySearchInput.value) {
                hierarchySearchInput.value = "";
                runSearch();
            } else {
                // Nothing left to undo: fold the box away, which is the state
                // it was found in.
                setFindOpen(false);
            }
            event.stopPropagation();
        } else if (event.key === "Enter") {
            activateFindRow(findActiveIndex < 0 ? 0 : findActiveIndex);
        } else if (event.key === "ArrowDown") {
            event.preventDefault();
            stepFindRow(1);
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            stepFindRow(-1);
        }
    });
}
if (hierarchyScopeCells) hierarchyScopeCells.addEventListener("click", () => setFindScope("cells"));
if (hierarchyScopeLabels) hierarchyScopeLabels.addEventListener("click", () => setFindScope("labels"));
if (hierarchyFindToggle) hierarchyFindToggle.addEventListener("click", () => setFindOpen(!findIsOpen()));
// Once up front, so the pair reads correctly before the first load rather than
// waiting for the refreshFind that comes with one.
updateFindScope();

// The "/" key: unfolds the box and puts the cursor in it, opening the panel too
// if that was away. Searching is the one thing in this panel reached for
// mid-look with a name already in mind, so a fold that has to be found with the
// mouse first would be a fold in the way -- this is what keeps it out of the
// way instead.
function focusFindBox() {
    if (!hierarchySearchInput || !hierarchyModel || !hierarchyModel.cellCount) return;
    if (hierarchyPanel && hierarchyPanel.classList.contains("hidden")) setHierarchyOpen(true, true);
    setFindOpen(true);
    hierarchySearchInput.select();
}

// ---- Marker browser (DRC/LVS violation databases) ----
// The parsed normalized model (see marker-parsers.js) is the JS-side source
// of truth for the browser UI; wasm only holds the flattened geometry it
// draws. Rebuilt from scratch on every marker load.
let currentMarkers = null;
let markersFolder = null;
let selectedMarkerId = -1;
let selectedMarkerRow = null; // the selected item's lil-gui row <div>, if it has one
const markerItemRows = new Map(); // item id -> row <div> (only the uncapped rows)

// Browser-wide controls, kept outside the model so they survive re-renders
// and marker-file swaps within a session. opacity scales the whole overlay's
// alpha in wasm; hideEmpty filters clean categories (0 violations) out of
// the panel (they draw nothing anyway).
const markerUiState = { opacity: 1.0, hideEmpty: false };

// The GUI's DOM does not survive 100k rows -- cap the rows per category and
// close with a disabled "… N more" row. Category visibility still covers
// capped-off items (it lives in wasm per-category), and [ / ] key stepping
// reaches them too.
const MAX_MARKER_ROWS_PER_CATEGORY = 200;

function removeMarkerBrowser() {
    if (markersFolder) {
        markersFolder.destroy();
        markersFolder = null;
    }
    markerItemRows.clear();
    selectedMarkerRow = null;
    selectedMarkerId = -1;
}

// Marks `item` selected (white emphasis in wasm + row highlight) and zooms
// the view to its bbox. Geometry-less items (bbox null) just select.
function selectMarker(Module, item) {
    if (selectedMarkerRow) selectedMarkerRow.classList.remove("marker-selected");
    selectedMarkerRow = markerItemRows.get(item.id) || null;
    if (selectedMarkerRow) selectedMarkerRow.classList.add("marker-selected");
    selectedMarkerId = item.id;
    Module.setSelectedMarker(item.id);
    if (item.bbox) {
        Module.zoomToBox(item.bbox.minX, item.bbox.minY, item.bbox.maxX, item.bbox.maxY);
    }
}

// %.4g-ish coordinate for the item rows -- full precision belongs in the
// tooltip, not a 260px panel.
function fmtCoord(v) {
    return Number(v.toPrecision(4)).toString();
}

function renderMarkerBrowser(model) {
    // Re-renders (e.g. the hide-empty toggle) keep the current selection;
    // fresh loads reset selectedMarkerId first (see the markersLoaded handler).
    const keepSelectedId = selectedMarkerId;
    removeMarkerBrowser();
    selectedMarkerId = keepSelectedId;

    const totalItems = model.categories.reduce((n, c) => n + c.items.length, 0);
    markersFolder = gui.addFolder(`Markers (${totalItems})`);
    markersFolder.open();

    if (model.warnings.length > 0) {
        console.error("[GDS] marker warnings:", model.warnings.join(" | "));
        const row = markersFolder.add({ w: () => {} }, "w")
            .name(`⚠ ${model.warnings.length} warning${model.warnings.length === 1 ? "" : "s"}`);
        row.domElement.title = model.warnings.join("\n");
    }

    const opacityController = markersFolder.add(markerUiState, "opacity", 0, 1, 0.05).name("Opacity")
        .onChange((value) => modulePromise.then((Module) => Module.setMarkerOpacity(value)));
    opacityController.domElement.title = "Opacity of the whole marker overlay";

    const emptyCount = model.categories.filter((c) => c.items.length === 0).length;
    const hideEmptyController = markersFolder.add(markerUiState, "hideEmpty").name("Hide empty categories")
        .onChange(() => renderMarkerBrowser(model));
    hideEmptyController.domElement.title =
        `Hide categories with 0 violations (currently ${emptyCount} of ${model.categories.length})`;

    model.categories.forEach((cat, categoryIndex) => {
        if (markerUiState.hideEmpty && cat.items.length === 0) return;
        const folder = markersFolder.addFolder(`${cat.name}  (${cat.items.length})`);
        folder.close();
        if (cat.description) folder.domElement.title = cat.description;

        // uiVisible (consulted by stepMarker so [ / ] skips hidden categories)
        // survives re-renders -- wasm keeps the real per-category visibility,
        // so the checkbox must not silently reset out of sync with it.
        // Categories start hidden (matching wasm's MarkerCategoryGL default):
        // the user opts in to the rulechecks they want drawn.
        if (cat.uiVisible === undefined) cat.uiVisible = false;
        const visState = { visible: cat.uiVisible };
        const visController = folder.add(visState, "visible").name("◼ visible")
            .onChange((visible) => {
                cat.uiVisible = visible;
                modulePromise.then((Module) => Module.setMarkerCategoryVisible(categoryIndex, visible));
            });
        visController.domElement.title = `Show/hide all ${cat.items.length} markers in ${cat.name}`;

        for (const item of cat.items.slice(0, MAX_MARKER_ROWS_PER_CATEGORY)) {
            const label = item.bbox
                ? `#${item.label} (${fmtCoord((item.bbox.minX + item.bbox.maxX) / 2)}, ${fmtCoord((item.bbox.minY + item.bbox.maxY) / 2)})`
                : `#${item.label}`;
            const controller = folder.add({ go: () => modulePromise.then((Module) => selectMarker(Module, item)) }, "go")
                .name(label);
            controller.domElement.title = [item.note, cat.description].filter(Boolean).join("\n") || label;
            markerItemRows.set(item.id, controller.domElement);
        }
        if (cat.items.length > MAX_MARKER_ROWS_PER_CATEGORY) {
            const more = folder.add({ m: () => {} }, "m")
                .name(`… ${cat.items.length - MAX_MARKER_ROWS_PER_CATEGORY} more (press [ or ] to step)`);
            more.domElement.classList.add("marker-more-row");
        }
    });

    // Restore the selected item's row highlight after a re-render.
    selectedMarkerRow = markerItemRows.get(selectedMarkerId) || null;
    if (selectedMarkerRow) selectedMarkerRow.classList.add("marker-selected");
}

// The [ and ] keys step the selection backward/forward through every item
// in checked categories (wrapping), including items past the per-category
// row cap. With no category checked (the default state right after a load),
// step through everything instead -- the selected marker draws regardless of
// category visibility, so stepping is never a dead key.
function stepMarker(direction) {
    if (!currentMarkers) return;
    let items = [];
    for (const cat of currentMarkers.categories) {
        if (cat.uiVisible === false) continue;
        items.push(...cat.items);
    }
    if (items.length === 0) {
        items = currentMarkers.categories.flatMap((cat) => cat.items);
    }
    if (items.length === 0) return;
    let idx = items.findIndex((it) => it.id === selectedMarkerId);
    idx = idx < 0 ? (direction > 0 ? 0 : items.length - 1) : (idx + direction + items.length) % items.length;
    modulePromise.then((Module) => selectMarker(Module, items[idx]));
}

// ---- Right-click menu on the canvas ----
// Right-clicking the layout offers the coordinate of the pixel that was
// clicked. Right-click is where "what is this, exactly" lives in every other
// tool, and it needs nothing to have been read beforehand -- unlike a shortcut,
// which only helps someone who already knows it's there.
//
// VS Code shows its own menu over a webview, but its preload skips that when
// the page has already called preventDefault ("Extension code has already
// handled this event"), which is what makes a menu of our own possible at all.
// It only covers the canvas: right-clicking the panels still gets VS Code's
// menu, since a coordinate means nothing there.
const copyToastEl = document.getElementById("copyToast");
let copyToastTimer = 0;
function showCopyToast(text) {
    if (!copyToastEl) return;
    copyToastEl.textContent = text;
    copyToastEl.classList.remove("hidden");
    clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => copyToastEl.classList.add("hidden"), 1800);
}

const canvasMenuEl = document.getElementById("canvasMenu");
const canvasMenuCopyEl = document.getElementById("canvasMenuCopy");
const canvasMenuValueEl = canvasMenuEl && canvasMenuEl.querySelector(".menu-value");
// The text the open menu is offering, captured when it opened. Held here rather
// than re-read on click because the click happens after the pointer has moved
// off the spot -- onto the menu item -- and the coordinate has to stay the one
// that was right-clicked.
let canvasMenuText = "";

function hideCanvasMenu() {
    if (canvasMenuEl) canvasMenuEl.classList.add("hidden");
}

function showCanvasMenu(clientX, clientY, text) {
    if (!canvasMenuEl) return;
    canvasMenuText = text;
    if (canvasMenuValueEl) canvasMenuValueEl.textContent = text;
    // Unhide first: the menu has no size to measure while it's display:none.
    canvasMenuEl.classList.remove("hidden");
    // Keep it on screen -- a right-click near the bottom or right edge would
    // otherwise open a menu that runs off it.
    const margin = 4;
    const maxLeft = window.innerWidth - canvasMenuEl.offsetWidth - margin;
    const maxTop = window.innerHeight - canvasMenuEl.offsetHeight - margin;
    canvasMenuEl.style.left = Math.max(margin, Math.min(clientX, maxLeft)) + "px";
    canvasMenuEl.style.top = Math.max(margin, Math.min(clientY, maxTop)) + "px";
    // Focus makes Enter and Escape work without a second reach for the mouse,
    // and lights the row the way hovering it does.
    if (canvasMenuCopyEl) canvasMenuCopyEl.focus();
}

if (glCanvas && canvasMenuEl && canvasMenuCopyEl) {
    glCanvas.addEventListener("contextmenu", (event) => {
        // Nothing to offer until the renderer is up (there's no camera yet, so
        // no coordinate) -- leave the event alone and let VS Code's menu open,
        // rather than swallowing the click for a menu that can't answer.
        if (!resolvedModule) return;
        event.preventDefault();
        showCanvasMenu(event.clientX, event.clientY,
                       resolvedModule.getCoordinateTextAt(event.clientX, event.clientY));
    });

    canvasMenuCopyEl.addEventListener("click", () => {
        const text = canvasMenuText;
        hideCanvasMenu();
        navigator.clipboard.writeText(text).then(
            () => showCopyToast("Copied \u2014 " + text),
            (err) => {
                // Same failure the debug log's Copy button guards against -- the
                // Clipboard API can be blocked in a sandboxed webview. There's no
                // select-and-Ctrl-C fallback for a number that isn't on the page
                // as selectable text, so the toast has to carry it: it stays up
                // long enough to read and to retype.
                console.error("[GDS] clipboard write failed for coordinate:", err);
                showCopyToast("Couldn't copy \u2014 " + text);
            }
        );
    });

    // Everything that means "not that, then": a click anywhere else (capture
    // phase, so a click on the canvas closes the menu before the renderer acts
    // on it), zooming or panning the layout out from under it, and leaving the
    // webview. Escape is handled with the other keys below.
    window.addEventListener("pointerdown", (event) => {
        if (!canvasMenuEl.contains(event.target)) hideCanvasMenu();
    }, true);
    window.addEventListener("wheel", hideCanvasMenu, { passive: true });
    window.addEventListener("resize", hideCanvasMenu);
    window.addEventListener("blur", hideCanvasMenu);
}

// Capture phase, because every lil-gui controller stopPropagation()s keydown
// in the bubble phase -- a plain window listener would never hear [ / ]
// while focus sits anywhere inside the panel, which is the normal state
// after clicking any row (boolean rows are <label>s that focus their
// checkbox; marker rows are <button>s that keep focus).
window.addEventListener("keydown", (event) => {
    // Don't hijack typing in lil-gui's text/number inputs -- but focused
    // checkboxes and buttons must not block marker stepping.
    const t = event.target;
    const tag = t && t.tagName;
    if (tag === "TEXTAREA" || (tag === "INPUT" && t.type !== "checkbox")) return;
    if (event.key === "[") stepMarker(-1);
    else if (event.key === "]") stepMarker(1);
    // Mode switching from the keyboard, since measuring is a two-hand job
    // (click, click, then back to panning): M enters measure mode, Escape
    // always lands back in pan mode and drops the ruler.
    else if (event.key === "m" || event.key === "M") setMode(currentMode === "measure" ? "pan" : "measure");
    // Escape is the "put the canvas back" key: it takes down the things the
    // viewer draws on top of the layout at the user's request. For rulers that
    // is two steps rather than one (see escapeMeasure in renderer.cpp) -- the
    // first press abandons a measurement being placed, and only a press with
    // nothing left to abandon clears the finished ones and leaves the mode.
    // A finished measurement is an annotation, so it shouldn't disappear on the
    // same keystroke that backs out of a half-drawn one.
    else if (event.key === "Escape") {
        // The canvas menu first and alone: it's the most recent thing put on
        // screen, and Escape shouldn't also throw away a measurement behind it.
        if (canvasMenuEl && !canvasMenuEl.classList.contains("hidden")) {
            hideCanvasMenu();
            return;
        }
        modulePromise.then((Module) => {
            if (!Module.escapeMeasure()) setMode("pan");
            refreshRulerRow(Module);
        });
        hierarchyDeselect();
    }
    // H shows/hides the hierarchy tree -- it's the one panel that takes a
    // slice of the viewport, so getting it out of the way is worth a key.
    else if (event.key === "h" || event.key === "H") toggleHierarchy();
    // "/" jumps to the find box (opening the panel if it's away), the way it
    // does in a file tree. preventDefault so the slash itself doesn't land in
    // the box that just took focus.
    else if (event.key === "/") {
        event.preventDefault();
        focusFindBox();
    }
}, true);

// ---- "Newer version on disk" banner ----
// The extension host watches the layout file and posts 'fileChanged' when it
// changes underneath us (see the watcher in extension.cjs); this is only the
// UI for that. Clicking Reload asks the host to re-read and re-send the file
// as a fresh 'init' -- the webview never touches disk itself.
const staleBanner = document.getElementById("staleBanner");
const staleText = document.getElementById("staleText");
const staleReloadBtn = document.getElementById("staleReloadBtn");
const staleAlwaysBtn = document.getElementById("staleAlwaysBtn");
const staleDismiss = document.getElementById("staleDismiss");

function showStaleBanner(show, text) {
    if (!staleBanner) return;
    if (text) staleText.textContent = text;
    staleBanner.classList.toggle("hidden", !show);
}

if (staleReloadBtn) {
    staleReloadBtn.addEventListener("click", () => {
        showStaleBanner(false);
        vscode.postMessage({ command: "reloadFile" });
    });
}
if (staleAlwaysBtn) {
    // "Reload, and stop asking": writes through to the GDS-Lens.autoReload
    // setting so the choice sticks across viewers and restarts. One-way by
    // design -- the banner only exists while auto-reload is off, so there's
    // nothing here to turn it back off with; that's the "GDSLens: Toggle
    // Auto-Reload on Change" command (and the Settings UI).
    staleAlwaysBtn.addEventListener("click", () => {
        showStaleBanner(false);
        vscode.postMessage({ command: "setAutoReload", value: true });
        vscode.postMessage({ command: "reloadFile" });
    });
}
if (staleDismiss) {
    staleDismiss.addEventListener("click", () => showStaleBanner(false));
}

// State carried across a reload so re-reading the file doesn't reset the
// user's working context. Captured just before the new geometry is uploaded
// (uploadLayers re-frames the camera and rebuilds the layer table from the
// new file), re-applied just after.
function captureViewState(Module) {
    const layers = Module.getLayers();
    // Nothing drawn yet (reload triggered while the first load was still in
    // flight) -- there's no camera worth keeping, and restoring the default
    // zoom-1-at-origin would override the framing uploadLayers is about to do.
    if (layers.length === 0) return null;
    const visibility = {};
    for (const layer of layers) {
        visibility[`${layer.layer}/${layer.datatype}`] = layer.visible;
    }
    return { camera: Module.getCamera(), visibility: visibility };
}

function restoreViewState(Module, saved) {
    if (!saved) return;
    // Only layers that existed before are restored -- ones the edit newly
    // introduced keep the fresh load's default so they aren't invisible for
    // no discoverable reason.
    for (const layer of Module.getLayers()) {
        const wasVisible = saved.visibility[`${layer.layer}/${layer.datatype}`];
        if (wasVisible !== undefined && wasVisible !== layer.visible) {
            Module.setLayerVisible(layer.layer, layer.datatype, wasVisible);
        }
    }
    Module.setCamera(saved.camera.zoom, saved.camera.panX, saved.camera.panY);
}

// ---- Named views ----
// A view is a camera plus which layers were on -- the two halves of "how I was
// looking at this design" -- saved under a name and kept with the layout by the
// extension host (see NAMED_VIEWS_KEY in extension.cjs), so they're still there
// when the file is reopened days later.
//
// Deliberately not part of one: the render toggles (Infill / Text / Merge /
// Grid). Those are a preference set once for how you like layouts drawn, not a
// place in a design -- which is exactly the split the Display folder is built
// around -- and a saved view that quietly flipped them back would undo a
// setting the user didn't think they were saving.
//
// Restoring is the reload path's restore, reused as-is: keeping the camera and
// the layer set across a re-read of the file is the same problem as putting
// them back from a name, and captureViewState/restoreViewState already are it.
const viewsFolder = gui.addFolder("Views");
viewsFolder.close();
// Nothing loaded yet has no view to save, so the folder isn't there to be
// opened until the first layout is drawn (see the gdsResult handler).
viewsFolder.hide();

// [{name, camera: {zoom, panX, panY}, visibility: {"1/0": true, ...}}], in the
// order they were saved. The host holds the copy that outlives the session; this
// is the working one.
let namedViews = [];
// The rows built for them, kept so a re-render can take exactly those down and
// leave the Save row (which isn't one of them) alone.
let viewControllers = [];
// The state captured when the name was asked for. A view should be the view you
// were looking at when you hit save, not wherever the camera ended up while the
// input box was open.
let pendingViewCapture = null;

const saveViewController = viewsFolder.add({ save: () => requestSaveView() }, "save")
    .name("Save Current View");
saveViewController.domElement.title =
    "Name the current camera and layer visibility, and keep it with this layout";

function persistNamedViews() {
    vscode.postMessage({ command: "saveNamedViews", views: namedViews });
}

// The name is asked for by the extension host rather than in the page: a
// webview has no prompt() to call, and the host's input box validates as you
// type and looks like the rest of the editor.
function requestSaveView() {
    modulePromise.then((Module) => {
        const captured = captureViewState(Module);
        // Null means nothing is drawn yet -- there's no camera worth naming.
        if (!captured) return;
        pendingViewCapture = captured;
        vscode.postMessage({
            command: "promptViewName",
            names: namedViews.map((view) => view.name)
        });
    });
}

// Saves under the name the host came back with. A name already in the list
// replaces that view in place rather than adding a second one under it: "save
// as Overview again" means the overview moved.
function saveNamedView(name) {
    const captured = pendingViewCapture;
    pendingViewCapture = null;
    if (!captured || !name) return;
    // The camera is copied field by field rather than passed along: what
    // getCamera() handed back crosses to the host and into stored state from
    // here, and this is the shape that has to keep working when it's read back
    // by a later version (see setNamedViews).
    const view = {
        name: name,
        camera: {
            zoom: captured.camera.zoom,
            panX: captured.camera.panX,
            panY: captured.camera.panY
        },
        visibility: captured.visibility
    };
    const at = namedViews.findIndex((existing) => existing.name.toLowerCase() === name.toLowerCase());
    if (at >= 0) namedViews[at] = view;
    else namedViews.push(view);
    renderNamedViews();
    persistNamedViews();
}

function deleteNamedView(view) {
    namedViews = namedViews.filter((existing) => existing !== view);
    renderNamedViews();
    persistNamedViews();
}

function restoreNamedView(view) {
    modulePromise.then((Module) => {
        // The solo snapshot describes the visibility set this is replacing, so
        // it would restore to a state that no longer exists.
        forgetSolo();
        restoreViewState(Module, view);
        // restoreViewState writes straight to wasm (it normally runs just
        // before the panel is rebuilt from scratch), so the checkboxes have to
        // be caught up by hand here -- rebuilding the whole layer list instead
        // would throw away the filter text and open folders with it.
        syncLayerRowsFromModule(Module);
    });
}

// Rebuilds just the view rows under the Save row. Each is a full-width button
// that restores the view, with an ✕ that deletes it -- the same shape as the
// loaded-file chips in the Display folder.
function renderNamedViews() {
    for (const controller of viewControllers) controller.destroy();
    viewControllers = [];
    viewsFolder.title(namedViews.length > 0 ? `Views  (${namedViews.length})` : "Views");

    for (const view of namedViews) {
        const controller = viewsFolder.add({ go: () => restoreNamedView(view) }, "go").name(view.name);
        controller.domElement.classList.add("view-row");
        controller.domElement.title =
            `${view.name} — click to put the camera and layer visibility back, ✕ to delete`;
        const remove = document.createElement("span");
        remove.className = "view-delete";
        remove.textContent = "✕";
        remove.title = `Delete "${view.name}"`;
        remove.addEventListener("click", (event) => {
            // The ✕ overlays the row's own <button> without being inside it, so
            // deleting a view can't also restore it on the way out.
            event.stopPropagation();
            deleteNamedView(view);
        });
        controller.domElement.appendChild(remove);
        viewControllers.push(controller);
    }
}

// What the host sends back from storage on open. Filtered rather than trusted:
// this is persisted state that a future version's shape could differ from, and
// a malformed entry would otherwise build a row that throws on click.
function setNamedViews(views) {
    namedViews = (Array.isArray(views) ? views : []).filter((view) =>
        view && typeof view.name === "string" && view.name.length > 0 &&
        view.camera && typeof view.camera.zoom === "number" &&
        typeof view.camera.panX === "number" && typeof view.camera.panY === "number");
    renderNamedViews();
}

const loadingOverlay = document.getElementById("loadingOverlay");
const loadingBarFill = document.getElementById("loadingBarFill");
const loadingPhase = document.getElementById("loadingPhase");
const loadingPercent = document.getElementById("loadingPercent");
const reloadProgress = document.getElementById("reloadProgress");
const reloadBarFill = document.getElementById("reloadBarFill");
const reloadLabel = document.getElementById("reloadLabel");
const loadError = document.getElementById("loadError");

// Every load-failure path ends here. Writing the DOM directly rather than
// going through Module.showLoadError matters: the module itself may be the
// thing that failed (instantiation rejected, or aborted on OOM mid-parse), in
// which case `modulePromise.then(...)` never runs and the user would be left
// staring at a stalled progress bar with no explanation. The wasm side is
// then told separately, best-effort, so it can clear any half-loaded layers.
function showFatalError(message) {
    console.error("[GDS] load failed:", message);
    loadError.textContent = "Could not open this layout\n\n" + message;
    endProgress();
    // Nothing loaded, so there's no cell tree to browse -- and leaving the
    // previous file's one up beside the error would invite clicking rows that
    // frame geometry no longer on screen.
    renderHierarchy(null);
    modulePromise.then((Module) => {
        Module.showLoadError(message);
        renderLayerList(Module.getLayers());
    }).catch(() => {
        // Module is gone -- the DOM message above is all we can offer.
    });
}

function clearFatalError() {
    loadError.textContent = "";
}

// describeLoadFailure comes from load-errors.js (its own <script> tag).

const phaseLabels = {
    parsing: "Parsing layout file...",
    flattening: "Flattening hierarchy...",
    triangulating: "Triangulating geometry..."
};

// Which of the two progress UIs the current load is driving (see
// beginProgress). Only one is on screen at a time, so updateProgress writes
// whichever that is.
let progressInline = false;

// inline: keep the viewport as it is and report progress in the top strip.
// Otherwise take the screen with the full overlay. Reloads pass true only
// when there's geometry already drawn to keep showing -- blanking the
// viewport for a reload throws away the very view the reload restores.
function beginProgress(inline) {
    progressInline = inline;
    loadingOverlay.classList.toggle("hidden", inline);
    reloadProgress.classList.toggle("hidden", !inline);
    updateProgress("parsing", 0, 1);
}

function endProgress() {
    loadingOverlay.classList.add("hidden");
    reloadProgress.classList.add("hidden");
}

function updateProgress(phase, current, total) {
    const label = phaseLabels[phase] || phase;
    const fraction = total > 0 ? current / total : 0;
    const percent = Math.round(fraction * 100);
    // Triangulation reports layers rather than a fraction of the file.
    const detail = phase === "triangulating" ? `Layer ${current}/${total}` : `${percent}%`;
    if (progressInline) {
        reloadBarFill.style.width = `${percent}%`;
        reloadLabel.textContent = `Reloading — ${label} ${detail}`;
        return;
    }
    loadingPhase.textContent = label;
    loadingBarFill.style.width = `${percent}%`;
    loadingPercent.textContent = detail;
}

// Registered synchronously (not inside the .then() below) so an 'init'
// message that arrives before wasm instantiation finishes isn't dropped --
// window message events aren't queued for late listeners.
console.log("[GDS] calling createGdstkModule() on main thread...");
// Synchronous handle on the same module modulePromise resolves to. The
// 'init' handler needs to read the *current* camera/layer state before the
// incoming parse replaces it, and a .then() would run too late for that.
let resolvedModule = null;
// The load currently in flight, so a reload can cancel it (see 'init').
let activeWorker = null;
// View state captured for the in-flight reload, re-applied once its geometry
// is uploaded. Null on a first open.
let pendingViewState = null;
const modulePromise = createGdstkModule();
modulePromise.then(
    (Module) => {
        resolvedModule = Module;
        console.log("[GDS] main-thread createGdstkModule() resolved OK");
    },
    (err) => {
        console.error("[GDS] main-thread createGdstkModule() REJECTED:", err);
        // Nothing else will ever run if this fails, so this is the one place
        // the message has to come from -- showFatalError's own best-effort
        // call into the module simply no-ops on the same rejection.
        showFatalError(`WebAssembly module failed to load: ${describeLoadFailure(err)}`);
    }
);

// ---- Theme (follows VS Code's light/dark theme) ----
// VS Code stamps the active theme kind onto <body> as vscode-light /
// vscode-dark / vscode-high-contrast[-light] and rewrites it live when the
// user switches themes, so the page chrome themes itself off that class in
// CSS alone (see the token block in viewer.html). What's left for JS is the
// half CSS can't reach: the canvas is drawn by renderer.cpp, which owns the
// background it clears to, the ruler/selection ink, and the fallback layer
// palette (all three assume a near-black background otherwise) -- plus the
// fallback for running this page outside a webview, where there is no
// vscode-* class and the OS preference is the only signal.
const lightMediaQuery = window.matchMedia("(prefers-color-scheme: light)");

function detectLightTheme() {
    const kinds = document.body.classList;
    // High-contrast light carries both vscode-high-contrast and
    // vscode-high-contrast-light, so the light check has to come first.
    if (kinds.contains("vscode-high-contrast-light") || kinds.contains("vscode-light")) return true;
    if (kinds.contains("vscode-high-contrast") || kinds.contains("vscode-dark")) return false;
    return lightMediaQuery.matches;
}

// Null until the first applyTheme(), so it can't match either decision and
// the initial push to wasm always happens.
let lightTheme = null;

function applyTheme() {
    const light = detectLightTheme();
    if (light === lightTheme) return;
    lightTheme = light;
    // The same class VS Code's own vscode-light would have set, so the OS
    // fallback lands on exactly the rules a webview gets for free. Toggling it
    // re-triggers the observer below, which then no-ops on this early return.
    document.body.classList.toggle("theme-light", light);
    modulePromise.then((Module) => {
        Module.setTheme(light);
        // setTheme recolors the layers in place (the fallback palette is
        // theme-dependent), so the panel's per-row color chips are stale.
        // Only worth rebuilding once there's a layer list to rebuild -- before
        // the first load renderLayerList would add an empty "Layers" folder.
        const layers = Module.getLayers();
        if (layers.length > 0) renderLayerList(layers);
    });
}

// A theme switch rewrites <body>'s class list rather than posting a message,
// so this is the only notification there is. (It also fires for the debug
// command's own class toggle, which applyTheme ignores.)
new MutationObserver(applyTheme).observe(document.body, { attributes: true, attributeFilter: ["class"] });
lightMediaQuery.addEventListener("change", applyTheme);
applyTheme();

window.addEventListener("message", (event) => {
    const message = event.data;
    console.log("[GDS] window message received, type:", message.type);
    if (message.type === "init") {
        console.log("[GDS] init payload: fileData byteLength =", message.fileData && message.fileData.byteLength,
                    "reload:", !!message.reload);
        // A reload supersedes any load still running (the file can change
        // again while a slow one is in flight) -- drop the old worker rather
        // than letting two of them race to upload geometry.
        if (activeWorker) {
            console.log("[GDS] superseding an in-flight load");
            activeWorker.terminate();
            activeWorker = null;
        }
        showStaleBanner(false);

        // Only meaningful on a reload: on first open there's nothing to keep,
        // and framing the view on the design is exactly what we want.
        // Captured synchronously off resolvedModule rather than through
        // modulePromise: the geometry has to be read *before* the new parse
        // lands, and a .then() would run after this handler returns.
        pendingViewState = null;
        if (message.reload && resolvedModule) {
            try {
                pendingViewState = captureViewState(resolvedModule);
            } catch (err) {
                // Nothing loaded yet, or the module is wedged -- reload as if
                // it were a first open (framed on the design) rather than
                // failing the reload outright.
                console.error("[GDS] could not capture view state, reloading framed:", err);
            }
        }

        // Captured state doubles as the test for "is there a view worth
        // keeping on screen": it's null exactly when nothing is drawn yet, and
        // an empty viewport behind a hairline bar reads as a hung viewer.
        beginProgress(pendingViewState !== null);

        let worker;
        try {
            // atob() yields a "binary string" -- one JS char per raw byte
            // (0-255), NOT real UTF-16 text. gdstk_wasm.js contains genuine
            // non-ASCII bytes (its embedded wasm binary), so passing that
            // string straight to `new Blob([...])` would have the Blob
            // constructor UTF-8-*encode* it as if it were text, expanding
            // every byte >=128 into a 2-byte sequence and corrupting the
            // wasm binary (surfaced as a WebAssembly.instantiate()
            // "section was shorter than expected size" CompileError inside
            // the worker). Converting to a Uint8Array first makes the Blob
            // use the raw bytes as-is.
            const binaryString = atob(document.getElementById("workerBundle").textContent);
            const bundleBytes = Uint8Array.from(binaryString, (c) => c.charCodeAt(0));
            console.log("[GDS] decoded worker bundle, length =", bundleBytes.length);
            const blobUrl = URL.createObjectURL(new Blob([bundleBytes], { type: "application/javascript" }));
            console.log("[GDS] created worker blob URL:", blobUrl);
            worker = new Worker(blobUrl);
            console.log("[GDS] new Worker() constructor returned OK");
        } catch (err) {
            console.error("[GDS] failed to build/start worker:", err);
            showFatalError(`Failed to create worker: ${err.message || err}`);
            return;
        }
        startWorker(worker, message.fileData);
    } else if (message.type === "loadError") {
        // The extension host gave up before it could send any bytes (file too
        // large, unreadable, ...) -- without this the overlay would spin
        // forever waiting for an 'init' that never comes.
        showFatalError(message.message);
    } else if (message.type === "lypLoaded") {
        modulePromise.then((Module) => {
            Module.loadLypText(message.text);
            renderLayerList(Module.getLayers());
        });
        setLypChip(message.name || null);
    } else if (message.type === "markersLoaded") {
        modulePromise.then((Module) => {
            let model;
            try {
                // Format sniffed by content (lyrdb XML vs Calibre ASCII) --
                // see marker-parsers.js, loaded via its own <script> tag.
                model = parseMarkerFile(message.text, DOMParser);
            } catch (err) {
                console.error("[GDS] marker parse failed:", err);
                removeMarkerBrowser();
                currentMarkers = null;
                Module.clearMarkers();
                setMarkerChip(message.name || null);
                markerController.domElement.title = `Failed to parse ${message.name}: ${err.message || err}`;
                return;
            }
            currentMarkers = model;
            Module.setMarkers(flattenMarkerModel(model));
            // The slider state outlives marker swaps; wasm resets selection
            // on setMarkers but keeps opacity, so re-assert both explicitly.
            Module.setMarkerOpacity(markerUiState.opacity);
            selectedMarkerId = -1;
            renderMarkerBrowser(model);
            setMarkerChip(message.name || null);
        });
    } else if (message.type === "namedViews") {
        // This layout's saved views, read back from the host's storage when the
        // editor opens (and after every change, which the host echoes nothing
        // back for -- this side already holds what it just sent).
        setNamedViews(message.views);
    } else if (message.type === "saveViewName") {
        // The name typed into the host's input box (see promptViewName).
        saveNamedView(message.name);
    } else if (message.type === "fileChanged") {
        // The file changed on disk and auto-reload is off, so offer it.
        showStaleBanner(true, message.text || "A newer version of this file is on disk.");
    } else if (message.type === "goToPoint") {
        // "GDSLens: Go to Coordinate". The host has already read the typed text
        // into a µm pair (see coord-parse.js), so all that's left here is the
        // pan -- the zoom is deliberately untouched, since a pasted coordinate
        // doesn't say how much around it you want to see (see goToPoint in
        // renderer.cpp). Only this side knows whether the point is inside the
        // layout, so the answer goes back for the host to report.
        modulePromise.then((Module) => {
            const onScreen = Module.goToPoint(message.x, message.y);
            // A crosshair on the coordinate itself, which fades out after a
            // couple of seconds (see draw_goto_flash in renderer.cpp). Panning
            // alone leaves you looking at a screen of layout with nothing
            // saying which part of it is the coordinate you pasted -- and when
            // clamp_pan has to hold the camera inside the design, it isn't even
            // the middle of the screen.
            Module.flashPoint(message.x, message.y);
            vscode.postMessage({
                command: "gotoResult",
                ok: !!onScreen,
                x: message.x,
                y: message.y
            });
        });
    } else if (message.type === "toggleDebugTools") {
        // "GDSLens: Toggle Debug Tools" command -- show/hide the debug entry
        // point (the button that opens #debugPanel, which holds both the
        // engine readout and the log), hidden by default, see viewer.html.
        document.body.classList.toggle("debug");
    }
});

function startWorker(worker, fileData) {
    activeWorker = worker;
    // Only fires for the Worker failing to start at all (e.g. its script
    // URL rejected by CSP) -- failures inside the worker's own async code
    // are reported via a 'gdsResult' message instead (see wasm-worker.js),
    // since a Worker's unhandled promise rejections don't reach this
    // handler.
    worker.onerror = (err) => {
        console.error("[GDS] worker.onerror fired:", err.message, "at", err.filename + ":" + err.lineno + ":" + err.colno, err.error);
        showFatalError(`Worker failed to start: ${err.message || err}`);
    };
    worker.onmessageerror = (err) => {
        console.error("[GDS] worker.onmessageerror fired (structured-clone failure):", err);
        showFatalError("Worker message failed to deserialize -- see devtools console");
    };
    worker.onmessage = (workerEvent) => {
        const workerMessage = workerEvent.data;
        if (workerMessage.type === "gdsLog") {
            // Relayed from wasm-worker.js's console.log/error patch --
            // the worker has no DOM to render its own debug panel into.
            appendDebugLine("[worker] " + workerMessage.text, workerMessage.level === "error");
            return;
        }
        // Deliberately not logging the full workerMessage here: the
        // 'gdsResult' message carries the entire parsed geometry (every
        // layer's outline/fill vertex arrays), and console.log is patched
        // above to JSON.stringify + append everything it's given to
        // #debugLog -- serializing and DOM-inserting the whole design on
        // every load was the dominant cost of moving parsing into a Worker
        // at all, swamping whatever the off-main-thread parse saved.
        console.log("[GDS] main thread received worker message:", workerMessage.type);
        if (workerMessage.type === "gdsProgress") {
            updateProgress(workerMessage.phase, workerMessage.current, workerMessage.total);
        } else if (workerMessage.type === "gdsResult") {
            // Free the worker's copy of the geometry before uploading ours:
            // on a big design both threads holding it at once is what tips a
            // borderline load over the edge.
            worker.terminate();
            if (activeWorker === worker) activeWorker = null;
            if (!workerMessage.ok) {
                showFatalError(workerMessage.error);
                return;
            }
            console.log("[GDS] load succeeded, layer count:", workerMessage.layers.length);
            modulePromise.then((Module) => {
                // uploadLayers is the other place a big layout can run out of
                // memory -- the parse fit in the worker, but this thread's
                // module now has to hold the same geometry plus its VBOs. An
                // unhandled throw here would leave the progress bar spinning
                // forever, so surface it like any other load failure.
                try {
                    Module.uploadLayers(workerMessage.layers, workerMessage.instanceGroups, workerMessage.bbox);
                } catch (err) {
                    showFatalError(describeLoadFailure(err));
                    return;
                }
                clearFatalError();
                // Put the camera and per-layer visibility back before the
                // panel is rebuilt, so renderLayerList reflects the restored
                // checkboxes rather than the fresh load's defaults.
                if (pendingViewState) {
                    try {
                        restoreViewState(Module, pendingViewState);
                    } catch (err) {
                        console.error("[GDS] could not restore view state:", err);
                    }
                    pendingViewState = null;
                }
                renderLayerList(Module.getLayers());
                renderHierarchy(workerMessage.hierarchy);
                // There's a view to save from now on (see viewsFolder.hide()).
                viewsFolder.show();
                // uploadLayers drops the rulers -- they were anchored to the
                // geometry this load just replaced.
                refreshRulerRow(Module);
                endProgress();
                console.log("[GDS] done, progress hidden");
            }, (err) => {
                showFatalError(`WebAssembly module failed to load: ${err && err.message ? err.message : err}`);
            });
        }
    };
    console.log("[GDS] posting 'parse' message to worker...");
    worker.postMessage(
        { type: "parse", fileData: fileData },
        [fileData]
    );
    console.log("[GDS] worker.postMessage('parse') call returned");
}
