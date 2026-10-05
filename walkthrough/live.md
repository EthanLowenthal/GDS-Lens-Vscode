## Live preview from Python

In a Python layout script, call `show()` on the component you are building:

```python
c.show()
```

The layout opens in GDS Lens beside your code. Run the script again and the
view reloads in place, keeping your camera and layer visibility.

GDS Lens listens on port 8082 for these. If another program already has the
port, `show()` goes there instead, and the GDS Lens item in the status bar says
so. Turn the server off with the `GDS-Lens.liveServer.enabled` setting.
