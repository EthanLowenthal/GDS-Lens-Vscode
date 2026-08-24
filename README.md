# GDS Lens — GDSII & OASIS layout viewer for VS Code

[![Visual Studio Marketplace](https://vsmarketplacebadges.dev/version-short/ethml.GDS-Lens.svg?style=flat-square&label=Marketplace&color=0f1720)](https://marketplace.visualstudio.com/items?itemName=ethml.GDS-Lens)
[![Installs](https://vsmarketplacebadges.dev/installs-short/ethml.GDS-Lens.svg?style=flat-square&label=installs&color=0f1720)](https://marketplace.visualstudio.com/items?itemName=ethml.GDS-Lens)
[![Open VSX downloads](https://img.shields.io/open-vsx/dt/ethml/GDS-Lens?style=flat-square&label=Open%20VSX%20downloads&color=0f1720)](https://open-vsx.org/extension/ethml/GDS-Lens)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENCE.md)

**Open a chip layout in VS Code.** GDS Lens adds a custom editor for `.gds`
(GDSII) and `.oas` / `.oasis` (OASIS) files, gzipped or not: open one and it's
parsed and rendered in a WebGL2 canvas, with KLayout `.lyp` colors, a cell
hierarchy tree, find-by-name, saved views, a snapping ruler and DRC/LVS marker
browsing. No install beyond the extension — no KLayout, no Python, no server.

![GDS Lens rendering a GDSII layout](images/example.png)

**Install:** search *GDS Lens* in the Extensions view, or
[get it on the Marketplace](https://marketplace.visualstudio.com/items?itemName=ethml.GDS-Lens)
/ [Open VSX](https://open-vsx.org/extension/ethml/GDS-Lens). Then open any
`.gds`, `.oas` or `.oasis` file.

## Features

- **GDSII and OASIS**, including gzipped (`.gds.gz`, `.oas.gz`, `.oasis.gz`).
- **Full hierarchy** — SREF/AREF, rotation, mirroring and magnification.
- **A cell tree** you can click through to frame and outline any cell.
- **Find by name** — any cell, or any of the layout's own text labels.
- **Saved views** — name a camera and layer set, and come back to it.
- **A PDK-scale layer panel** — filter, solo, shape counts, bulk show/hide.
- **KLayout `.lyp` colors**, remembered per layout.
- **A ruler** with vertex/edge snapping and axis constraint.
- **DRC/LVS markers** from KLayout `.lyrdb` or Calibre DRC ASCII results.
- **Coordinate readout, scale bar and grid**, plus a go-to-coordinate command.
- **Your VS Code theme**, light or dark, switching live.

## Getting started

Open any `.gds`, `.oas`, `.oasis` file — or a gzipped one — and it opens in the
viewer. Neither gzip nor the layout format is decided by the filename: both are
read from the file's leading bytes, so a layout with an unexpected extension
still loads, and so does a `.gds` that turns out to be gzipped.

Then: drag to pan, scroll to zoom.

## The viewer

### Hierarchy

The **Hierarchy** button in the top-left corner (or `H`) opens the design's cell
tree, starting from its top cell(s).

- **Click ▸** to see the cells a cell places; **click the row** to frame that
  cell and outline every placement of it on the canvas.
- Outlines are dashed, stay on the geometry as you pan and zoom, and clear with
  `Esc`.
- A cell placed more than once by its parent is one row marked `×N`; clicking it
  outlines and frames all N copies. (Past ~1,000 copies, one outline around the
  lot.)
- Open branches and the selection survive a reload, so re-running a generator
  leaves the tree where you had it.

#### Finding a cell or a label

**Find** — the folded row under the panel's header — searches the two things in a
design that have names: its cells, and the layout's own `TEXT` labels, with
**Cells | Labels** choosing which. It starts closed, since the panel is there to
browse the tree; `/` opens it and lands in the box from anywhere, opening the
panel too if that was away.

- **Results take the tree's place** while a query is up, and clearing the box
  puts the tree back with its open branches untouched.
- **Cells** match by name, exact matches first. Clicking one *opens the tree down
  to it*: the branches above it unfold, the row is selected and framed, and every
  placement is outlined — the same as having found the row by hand. The query
  stays in the box, so clicking back into it brings the list back.
- **Labels** match by text, including labels on layers you've hidden (the row
  says so). Clicking one pans to it and marks it with a dashed box, leaving the
  zoom alone — a label is drawn at a fixed size on screen, so there's no extent
  to frame. Text drawing switches on if it was off, since finding a label and
  showing nothing isn't an answer.
- **↑ ↓ and Enter** walk the list and take a row; `Esc` clears the query, and
  again folds the box away. Closing it clears the search and puts the tree back.
- A query survives a reload of the same file and is re-run against what was
  read, like the rest of the working context.

### Layers

- **Per-layer visibility**, grouped by the `.lyp`'s categories, with each row
  showing how many shapes that layer holds in this file (`T`*n* for a
  text-only layer).
- **Filter** narrows the list by layer number, datatype, name or group. Matching
  folders open while you type and go back as they were when you clear it.
- **Show: All | None | Invert** applies to whatever the filter is showing, so
  filtering to one family and hiding it takes two clicks.
- **S** solos a layer; clicking it again restores the layers that were on before.

### Display

A collapsed folder for the things you set once:

| Control | Does |
| --- | --- |
| **Infill** | Hatched layer fill on/off |
| **Text** | The layout's own `TEXT` labels, drawn in their layer's color (off by default — a dense design's labels bury the geometry) |
| **Merge Overlaps** | Draw each layer as the union of its polygons, without internal edges |
| **Grid** | Background reference grid, pitched at a round nm/µm/mm step that follows the zoom (on by default) |
| **Load KLayout .lyp File** | Custom layer colors |
| **Load Marker File** | A DRC/LVS marker database — see below |
| **Reset View** | Refit the layout to the window |

### Saved views

**Views** in the panel keeps named places in a design. **Save Current View**
asks for a name and stores the camera together with which layers were on;
clicking a saved view puts both back, and the ✕ deletes it.

Views are kept per layout and survive closing the file — so "pad ring", "the
corner that failed DRC" or "metal only, full chip" are still there next week.
The render toggles in **Display** are deliberately not part of a view: those are
how you like layouts drawn, not a place in one.

### Measuring

**Mode: Pan | Measure** sits at the top of the panel (or press `M`). In
**Measure**, click two points for the distance, Δx, Δy and angle between them.

- **Snapping** — points land on the nearest polygon vertex or edge within ~12px,
  marked by a small square before you click. Hold `Alt` to place a point freely.
- **`Shift`** constrains the second point to horizontal or vertical.
- **Rulers stay put** — finished measurements remain on the canvas so several can
  be compared at once, and they survive leaving Measure mode. A **Rulers: Clear
  *n*** row appears while any are up.

### Coordinates

The coordinate under the pointer is shown as `X: … Y: …` below the scale bar,
always in microns; zoom sets the precision, to a tenth of the grid's current
step.

**Right-click the layout → Copy coordinate** puts the coordinate of the pixel
you clicked on the clipboard as `X=…, Y=…`, with the same digits the readout is
showing. It pastes straight back into **Go to Coordinate**, or into a script or
a message.

**GDSLens: Go to Coordinate** centers the view on a coordinate you paste in —
microns unless a number carries its own `nm`/`um`/`µm`/`mm`, and the decorations
DRC reports and messages wrap them in (parentheses, `x=`/`y=`, commas or bare
spaces) are all accepted. The zoom is left alone. A crosshair marks where you
landed and fades out after a couple of seconds, so the spot is visible even when
the point sits off-centre — which it does whenever a coordinate lands near (or
outside) the edge of the design.

### DRC/LVS markers

**Load Marker File** takes a KLayout `.lyrdb` report database or a Calibre DRC
ASCII results database (detected from the file's content, not its extension).

- Violations draw as a red overlay above all layers.
- The **Markers** panel lists each category (rulecheck) with a visibility toggle
  and clickable items that zoom to the violation; `[` / `]` step through them.
- Categories start hidden — check the rulechecks you want drawn. Clicking an item
  always shows that marker, even if its category is hidden.
- Also: an overlay opacity slider, and **Hide empty categories**.
- The marker file is remembered per layout and re-applied when you reopen it;
  unload it with the ✕ on the panel row.

### Reloading after a rewrite

When the open layout is rewritten on disk (by a generator script, KLayout, ...) a
header offers **Reload**, which re-reads the file while keeping the camera and
per-layer visibility. **Always** reloads without asking from then on.

## Keyboard shortcuts

| Key | Does |
| --- | --- |
| `H` | Show/hide the hierarchy panel |
| `/` | Open the find box (cells and labels) and type in it |
| `↑` `↓` `Enter` | (Find) walk the results, take a row |
| `M` | Switch between Pan and Measure |
| `Esc` | Clear the find query, abandon a measurement, clear finished rulers, or clear cell outlines |
| `Alt` | (Measure) place a point without snapping |
| `Shift` | (Measure) constrain to horizontal or vertical |
| `[` `]` | Step through marker violations |

## Commands

| Command | Does |
| --- | --- |
| **GDSLens: Go to Coordinate** | Center the view on a pasted coordinate |
| **GDSLens: Toggle Auto-Reload on Change** | Turn automatic reloading on or off (the `GDS-Lens.autoReload` setting) |
| **GDSLens: Toggle Debug Tools** | Show/hide the render stats readout and debug log |

## Release notes

See [`CHANGELOG.md`](CHANGELOG.md).

## Contributing

Build and development instructions are in [`DEVELOPING.md`](DEVELOPING.md).
