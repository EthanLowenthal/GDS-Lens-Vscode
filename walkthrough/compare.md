## Compare two layouts

Two ways to start:

- With a layout open, press `Ctrl+K D` (`Cmd+K D` on macOS) or click the
  compare icon in the editor title bar, then pick the other file. The open
  layout is **A** and the one you pick is **B**.
- Select two layout files in the Explorer, right-click, and choose
  **Compare Layouts**. A is the one whose path sorts first.

Both layouts are drawn in one viewer with one camera. The **Compare** folder
lists which file is A and which is B, then:

- **A ↔ B** crossfades between them. Drag it from one end to the other and
  back to see what moved.
- **Highlight differences** marks where they disagree, layer by layer: red
  where only A has geometry, green where only B does. Zoom in to find smaller
  differences; it shows where to look, not an exact geometric comparison.
- **Tint sources** gives each layout its own hue, for when both revisions use
  the same colors.

In the **Layers** list, a layer that only one layout has is marked **A** or
**B**.
