## DRC and LVS markers

Open **Display** in the panel and click **Load Marker File**. It reads a
`.lyrdb` report database or an ASCII DRC results file. The file is remembered
for that layout and loads again the next time you open it.

The **Markers** folder lists each rulecheck with its marker count. Rulechecks
start hidden, so nothing is drawn until you pick what to look at:

- Click a marker's row to zoom to it. It is drawn even while its rulecheck is
  hidden.
- Turn on **◼ visible** in a rulecheck to draw all of its markers.

| Key | Action |
| --- | --- |
| `[` `]` | Previous or next marker |

With a marker selected in a hidden rulecheck, `[` and `]` stay within that
rulecheck. Otherwise they step through every rulecheck you have turned on.

**Opacity** fades the whole overlay. Click ✕ on the file's row to unload it.
