# GDS Lens

[![Visual Studio Marketplace](https://vsmarketplacebadges.dev/version-short/ethml.GDS-Lens.svg?style=flat-square&label=Marketplace&color=0f1720)](https://marketplace.visualstudio.com/items?itemName=ethml.GDS-Lens)
[![Installs](https://vsmarketplacebadges.dev/installs-short/ethml.GDS-Lens.svg?style=flat-square&label=installs&color=0f1720)](https://marketplace.visualstudio.com/items?itemName=ethml.GDS-Lens)
[![Open VSX downloads](https://img.shields.io/open-vsx/dt/ethml/GDS-Lens?style=flat-square&label=Open%20VSX%20downloads&color=0f1720)](https://open-vsx.org/extension/ethml/GDS-Lens)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENCE.md)

GPU-accelerated GDSII and OASIS viewer for VS Code, built in C++ and compiled
to WebAssembly. It renders layouts of over 100 million polygons with nothing
else installed, including on vscode.dev.

![GDS Lens rendering a GDSII layout](images/example.png)

[Try it in the browser](https://lowenth.al/GDS-Lens/) by dropping a layout on
the page. The extension is the same viewer inside VS Code.

## Install

Search for *GDS Lens* in the Extensions view, or install it from the
[Marketplace](https://marketplace.visualstudio.com/items?itemName=ethml.GDS-Lens)
or [Open VSX](https://open-vsx.org/extension/ethml/GDS-Lens). Then open any
`.gds`, `.oas`, or `.oasis` file. Gzipped files open too. The format is read
from the file's contents, not its extension.

Drag to pan. Scroll to zoom.

## Features

- **Large layouts**: GPU instancing draws repeated cells once. Up to 820M polygons once flattened, a 37 MB file on screen in 0.25 s, and smooth panning and zooming on a 127M polygon layout.
- **Ports**: photonic and electrical ports stored in the layout's metadata are drawn with orientation arrows, colored by type, and listed for the top cell.
- **Layer panel**: automatic colors, per-layer toggles, filter, solo, shape counts, bulk show/hide. Load a KLayout `.lyp` to match your PDK colors.
- **Hierarchy**: browse the cell tree, frame any cell, and outline every placement of it.
- **Find**: search cells and text labels by name.
- **Ruler**: measure with snapping to vertices and edges.
- **Saved views**: name a camera position and layer set and return to it later.
- **DRC/LVS markers**: browse `.lyrdb` or ASCII marker databases as an overlay.
- **Compare layouts**: open two files overlaid in one viewer, crossfade between them, and highlight where they differ.
- **Auto reload**: when a generator script rewrites the file, the view updates and keeps your camera and layer visibility.
- **Theme**: follows your VS Code light or dark theme.

## Use the viewer

### Hierarchy

Press `H` or click **Hierarchy** to open the cell tree. Click a row to frame
that cell and outline every placement of it on the canvas. Press `Esc` to clear
the outlines. A cell placed more than once by its parent is one row marked `×N`.

### Find

Press `/` to open the search box. **Cells** matches cell names and opens the
tree down to the result. **Labels** matches the layout's `TEXT` labels,
including labels on hidden layers, and pans to the match. Use `↑` `↓` and
`Enter` to pick a result. The tree returns when you clear the box.

### Layers

Every layer gets a color and a row with a toggle and its shape count in this
file, with no setup. Filter by layer number, datatype, name, or group.
**Show: All | None | Invert** applies to the filtered rows. Click **S** to solo
a layer; click it again to restore the previous selection. To use your PDK's
colors and groups, click **Load .lyp File** in Display. The `.lyp` is
remembered per layout.

### Display

| Control | Effect |
| --- | --- |
| **Infill** | Hatched layer fill on or off |
| **Text** | Draw the layout's `TEXT` labels in their layer's color. Off by default. |
| **Ports** | Draw ports stored in the layout's metadata. Off by default. |
| **Merge Overlaps** | Draw each layer as the union of its polygons, without internal edges |
| **Grid** | Reference grid at a round nm, µm, or mm step that follows the zoom |
| **Load .lyp File** | Custom layer colors |
| **Load Marker File** | DRC/LVS marker database |
| **Reset View** | Refit the layout to the window |

### Saved views

Click **Save Current View** to store the camera and layer visibility under a
name. Click a saved view to restore both. Views are kept per layout and survive
closing the file.

### Measure

Press `M` to switch to Measure mode. Click two points to read the distance,
Δx, Δy, and angle. Points snap to the nearest vertex or edge. Hold `Alt` to
place a point freely, or `Shift` to constrain to horizontal or vertical.
Finished rulers stay on the canvas until you clear them with `Esc`.

### Coordinates

The pointer coordinate is shown below the scale bar in microns. To copy it,
right-click the layout and choose **Copy coordinate**. To jump to a coordinate,
run **GDS Lens: Go to Coordinate** and paste it. Units `nm`, `um`, `µm`, and
`mm` are accepted, as are the formats DRC reports use, such as `(x, y)` or
`x=…, y=…`. A crosshair marks where you landed.

### DRC/LVS markers

Click **Load Marker File** and choose a `.lyrdb` report database or an ASCII
DRC results file. Violations draw as a red overlay above all layers. The
**Markers** panel lists each rulecheck with a visibility toggle. Click an item
to zoom to it, or press `[` and `]` to step through. The marker file is
remembered per layout.

### Ports

Each port is drawn as a bar across its width with an arrow in the direction it
faces: orange for optical, green for electrical, blue for other types. The
**Ports** folder lists the top cell's ports; click one to center on it. The
overlay is off until you turn on **Display > Ports**. The top cell's ports are
drawn at every zoom, and ports inside placed cells are drawn once you zoom in
far enough that 3,000 or fewer are in view. Ports are read from the KLayout metadata that gdsfactory 8 and kfactory write into
GDSII and OASIS files. Files without it look unchanged.

### Reload

When the open file changes on disk, a header offers **Reload**. Reloading keeps
the camera and layer visibility. Click **Always** to reload without asking.

### Compare layouts

Two ways in:

- With a layout open, use the compare button in the editor's title bar, or run
  **GDS Lens: Compare Current Layout With...**, and pick the file to compare
  against. The open layout is A, the one you pick is B. The picker opens in
  the open layout's folder.
- Or select two layout files in the Explorer, right-click, and choose **Compare
  Layouts**. Running that command with nothing selected asks for both files.

Both open in one viewer, overlaid through one camera, and the panel gains a
**Compare** folder:

- **A ↔ B** crossfades between them. Either end shows one layout on its own,
  the middle overlays both. Flicking between the ends shows what moved.
- **Tint sources**, off by default, shifts each layout toward its own hue, so
  two revisions with the same colors can be told apart in the overlay.
- **Highlight differences** marks, layer by layer, where the two disagree: red
  where only A has geometry, green where only B does. It works at the
  resolution you are viewing, so zoom in to resolve smaller differences. It
  shows where to look; it is not a geometric XOR and does not report an area.

The layer list shows both layouts' layers, marked **A** or **B** where only
one of them has it, so a layer added or removed between revisions shows up as
a row. The hierarchy browser roots both cell trees, and cell and label search
covers both, with the same marks on the results.

Everything else is single: one camera, one set of rulers, one `.lyp`, one
marker database. The reload banner names whichever file changed on disk, and
reloading clears rulers, as it does for a single layout.

## Performance

Parsing, flattening, and triangulation run in a WebAssembly worker, off the
main thread, so the editor stays responsive while a file loads. Drawing is
WebGL2 on the GPU, with one vertex buffer per layer.

A cell is GPU-instanced based on what instancing saves, not on how often it is
placed. Instancing avoids storing a flattened copy of every placement, but
costs a draw call per cell per layer in every frame. A cell is instanced when
its flattened copies would take a lot of memory, so a cell placed 100,000
times still instances, while a small cell placed a dozen times is flattened
into its layer's buffer.

Panning and zooming a very large layout reprojects the last render instead of
redrawing the geometry, then does one real render when the camera stops. The
frame it settles on is the same as one drawn without reprojection. Merge
Overlaps and the compare difference highlight are not covered and redraw
every frame.

Measured on generated stress layouts and a 37 MB test layout:

- The 37 MB GDSII file is on screen in about 0.25 s.
- Dragging a 127M polygon layout takes 8.4 ms a frame, down from 606 ms.
- A test chip of 2.5M polygons in 8,000 distinct cells draws a frame in under
  1 ms, down from 108 ms, and loads in 1.27 s, down from 4.35 s.

Everything is held in the 4 GB address space of 32-bit wasm, which sets these
limits on what loads. The limit depends on how much of the layout is distinct
geometry:

| Layout | Limit |
| --- | --- |
| Repeated cells (100 cells of 40 rectangles, placed 20M times) | 820M polygons once flattened |
| Flat rectangles | 10M polygons |
| Flat 40-vertex curves, like waveguide routing | 2.3M polygons |

To measure your own files, run `npm run bench -- <file>...`. See
[Benchmarking](DEVELOPING.md#benchmarking).

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `H` | Show or hide the hierarchy panel |
| `/` | Open the find box and type in it |
| `↑` `↓` `Enter` | Walk the find results and pick one |
| `M` | Switch between Pan and Measure |
| `Esc` | Clear the find query, abandon a measurement, clear finished rulers, or clear cell outlines |
| `Alt` | Place a measure point without snapping |
| `Shift` | Constrain a measure point to horizontal or vertical |
| `[` `]` | Step through marker violations |

## Commands

| Command | Action |
| --- | --- |
| **GDS Lens: Go to Coordinate** | Center the view on a pasted coordinate |
| **GDS Lens: Compare Layouts** | Open two layouts overlaid in one viewer, with a crossfade and a difference highlight |
| **GDS Lens: Compare Current Layout With...** | Compare the layout you have open against another you pick |
| **GDS Lens: Toggle Auto-Reload on Change** | Turn automatic reloading on or off (the `GDS-Lens.autoReload` setting) |
| **GDS Lens: Toggle Debug Tools** | Show or hide the render stats readout and debug log |

## Release notes

See [`CHANGELOG.md`](CHANGELOG.md). Build instructions are in
[`DEVELOPING.md`](DEVELOPING.md).
