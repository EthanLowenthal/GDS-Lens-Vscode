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

- **Large layouts**: GPU instancing draws repeated cells once. 115 million flattened polygons in 2 GB, a 37 MB file on screen in 0.25 s.
- **Ports**: photonic and electrical ports stored in the layout's metadata are drawn with orientation arrows, colored by type, and listed for the top cell.
- **Layer panel**: automatic colors, per-layer toggles, filter, solo, shape counts, bulk show/hide. Load a KLayout `.lyp` to match your PDK colors.
- **Hierarchy**: browse the cell tree, frame any cell, and outline every placement of it.
- **Find**: search cells and text labels by name.
- **Ruler**: measure with snapping to vertices and edges.
- **Saved views**: name a camera position and layer set and return to it later.
- **DRC/LVS markers**: browse `.lyrdb` or ASCII marker databases as an overlay.
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
| **Ports** | Draw ports stored in the layout's metadata. On by default. |
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
run **GDSLens: Go to Coordinate** and paste it. Units `nm`, `um`, `µm`, and
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
**Ports** folder lists the top cell's ports; click one to center on it. Ports
are read from the KLayout metadata that gdsfactory 8 and kfactory write into
GDSII and OASIS files. Files without it look unchanged.

### Reload

When the open file changes on disk, a header offers **Reload**. Reloading keeps
the camera and layer visibility. Click **Always** to reload without asking.

## Performance

Parsing, flattening, and triangulation run in a WebAssembly worker, off the
main thread, so the editor stays responsive while a file loads. Drawing is
WebGL2 on the GPU, with one vertex buffer per layer and instancing for any cell
placed eight or more times. Measured on generated stress layouts and a 37 MB test
layout:

- The 37 MB GDSII file is on screen in about 0.25 s.
- A hierarchy that flattens to 115 million polygons loads in about 2 GB of
  memory. The 4 GB address space of 32-bit wasm is the ceiling.
- Flat geometry costs about 1 KB per top-level polygon, so a few million
  unreferenced polygons is the practical limit.

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
| **GDSLens: Go to Coordinate** | Center the view on a pasted coordinate |
| **GDSLens: Toggle Auto-Reload on Change** | Turn automatic reloading on or off (the `GDS-Lens.autoReload` setting) |
| **GDSLens: Toggle Debug Tools** | Show or hide the render stats readout and debug log |

## Release notes

See [`CHANGELOG.md`](CHANGELOG.md). Build instructions are in
[`DEVELOPING.md`](DEVELOPING.md).
