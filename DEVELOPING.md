# Developing GDS Lens

Developer documentation for building and hacking on the extension. For usage,
see [`README.md`](README.md).

## Project layout

- `src/extension.cjs` — the extension host. Opens the layout file
  (`.gds` / `.oas` / `.oasis`, optionally gzipped), streams its bytes into the
  webview, and relays the `.lyp` and marker file pickers. Uses no Node builtins,
  so the one bundle serves both the desktop host and the Web Worker host —
  see "Running on the web" below.
- `src/layout-bytes.js` — gzip expansion for `.gds.gz` and friends, detected by
  gzip's magic number rather than by extension. Deliberately runs in the
  extension host: see "Layout size limits" below for why it can't be the wasm
  module's job. Standalone (no imports, `DecompressionStream` rather than
  `zlib`) and `require()`d directly by the unit tests, same as
  `marker-parsers.js`.
- `src/viewer.html` / `src/viewer.js` — the webview: bootstraps the wasm
  module and wires up `postMessage` from the extension host.
- `src/marker-parsers.js` — standalone parsers for DRC/LVS marker databases
  (KLayout `.lyrdb`, Calibre DRC ASCII); loaded in the webview via a
  `<script>` tag and `require()`d directly by the unit tests.
- `src/cell-search.js` — the two pure functions behind the hierarchy panel's
  find box: ranking the cells a typed name matches, and the depth-first walk
  that finds which branch the tree has to open to show one. Standalone for the
  same reason `marker-parsers.js` is — a `<script>` tag in the webview, and
  `require()`d directly by the unit tests.
- `src/coord-parse.js` — reads an `x, y` pair out of pasted text (the units and
  decorations real DRC reports print). Standalone for the same reason
  `marker-parsers.js` is: the "Go to Coordinate" command validates the input box
  with it in the extension host, and the unit tests `require()` it directly.
- `src/wasm/` — C++ source compiled with Emscripten into
  `src/wasm/build/gdstk_wasm.js`, which does GDSII/OASIS parsing and WebGL
  rendering. `renderer.cpp` holds the renderer proper (GL state, camera,
  input, layer upload, the embind API); `bindings.cpp` exposes the parse path
  on its own for non-graphical testing. The pieces that depend on none of the
  renderer's state sit beside them: `shaders.hpp` (the GLSL sources),
  `stroke_font.{hpp,cpp}` (the vector font labels are drawn with),
  `lyp_util.{hpp,cpp}` (the string/color primitives the `.lyp` reader uses)
  and `gds_common.hpp` (shared with `bindings.cpp`). Which of gdstk's two
  readers runs is decided by sniffing the file header in `gds_common.hpp`, so
  no caller has to know the format. See `docs/rendering-rewrite.md` for the
  design history of this C++/WASM architecture.
- `third_party/gdstk`, `third_party/qhull` — git submodules the wasm build
  links against.
- `third_party/earcut` — git submodule, header-only (`mapbox/earcut.hpp`).
  Nothing to compile; the build only adds its include path. `triangulate()` in
  `renderer.cpp` hands it every concave polygon, and specializes
  `mapbox::util::nth<>` so it reads gdstk's `Vec2` in place.
- `test/` — plain-Node tests (`npm test`): marker-parser and gzip unit tests plus
  headless tests that eval the built wasm bundle in Node (skipped when
  `src/wasm/build/gdstk_wasm.js` hasn't been built) covering marker state and
  the GDSII/OASIS readers. `test/fixtures/sample_layout.{gds,oas}` are the
  same KLayout-built design written in both formats.

## Building

GDS parsing and WebGL rendering run in a C++/WebAssembly module (`src/wasm/`,
built against the bundled `gdstk` submodule). Building it requires the
[Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)
(`emcc`/`emcmake` on `PATH`). After installing the SDK and initializing
submodules (`git submodule update --init --recursive`):

```sh
npm run build:wasm
```

This configures and builds `src/wasm/build/gdstk_wasm.js`, which
`src/extension.cjs` loads into the webview at runtime. Re-run it after
changing any `src/wasm/*.cpp` file or the `gdstk`/`third_party/qhull`
submodules.

The extension host itself is bundled with esbuild into `dist/extension.js`,
which is what both `main` and `browser` point at:

```sh
npm run compile      # or `npm run watch` while working on the host
```

`npm run package` does this for you via `vscode:prepublish`. Nothing under
`src/` other than the three host-only files is bundled — `viewer.html` and the
scripts it pulls in are loaded from the extension's own directory at runtime
and ship as-is.

## Running

Press `F5` in VS Code to launch an Extension Development Host with the
extension loaded, then open a `.gds` or `.oas` file.

## Running on the web

The extension is a [web
extension](https://code.visualstudio.com/api/extension-guides/web-extensions):
the same bundle runs unchanged on vscode.dev and github.dev, where extensions
execute in a Web Worker rather than in Node. To try it:

```sh
npm run test:web     # serves the extension to a local Chromium on vscode.dev
```

Almost all of the viewer was already portable — the wasm module is built with
`-sSINGLE_FILE` so the `.wasm` is base64 inside `gdstk_wasm.js` with nothing to
fetch, and the webview and its parse Worker were always browser code. The
extension host was the part that wasn't, and it stays portable only by using
no Node builtins at all:

- **No `fs`/`path`.** File access goes through `vscode.workspace.fs` and
  locations through `vscode.Uri`. In particular `uri.fsPath` is avoided for
  anything but backwards compatibility: a layout opened from github.dev is a
  `vscode-vfs:` URI with no filesystem path behind it. That is also why the
  remembered `.lyp`/marker locations and the per-layout state maps are keyed by
  `uri.toString()`, with a fallback read of the old `fsPath` keys so state
  written before the port survives.
- **No `zlib`.** `src/layout-bytes.js` expands gzipped layouts with
  `DecompressionStream`, which makes it async and makes the size cap its own
  job to enforce.
- **No `Buffer`.** `TextDecoder` and a chunked `btoa` do the text and base64
  conversions instead.

`eslint.config.mjs` gives the host files worker globals rather than Node ones,
so reaching for any of the above is a lint warning rather than a failure that
only shows up in a browser.

What genuinely differs on the web is the environment, not the code: there is no
local disk, so the `.lyp` and marker pickers can only reach files in the opened
virtual workspace, and a read-only filesystem provider emits no change events,
so auto-reload never fires there.

## Layout size limits

Parsing, flattening and triangulating all happen inside a 32-bit WebAssembly
module, so everything has to fit in one 4 GB address space
(`-sMAXIMUM_MEMORY` in `src/wasm/CMakeLists.txt` — Emscripten's default is
only 2 GB). What that buys, measured against generated stress layouts:

- **Flat geometry is the expensive case.** ~1 KB per polygon end to end
  (gdstk polygon + triangulated vertices + the typed arrays handed to JS), so
  a couple of million top-level polygons is the practical ceiling.
- **Hierarchy is nearly free.** A cell placed at least `kInstanceThreshold`
  (8) times anywhere in the design becomes a GPU instance batch — 24 bytes per
  placement instead of a full geometry copy. A hierarchy that flattens to
  115M polygons loads in ~2 GB; the same 4 GB budget is exhausted somewhere
  under 1G.

A gzipped layout is expanded before any of this, in the extension host
(`src/layout-bytes.js`), and the ceilings above apply to what it expands *to* —
which is also what `MAX_LAYOUT_BYTES` is checked against for a `.gz`, rather
than its size on disk. Expanding it in Node rather than inside the wasm module
is the whole point: the module would have to hold the compressed bytes and the
expanded bytes at once, in the one 4 GB address space that already has to fit
the flattened geometry, whereas Node's heap has neither constraint. `zlib`'s
`maxOutputLength` is what enforces the cap, so a small archive claiming to
expand to 40 GB is stopped as it overruns rather than after it has allocated.

Past that the module aborts. The abort is a JS throw, so it's caught in
`wasm-worker.js`, run through `describeLoadFailure` (`src/load-errors.js`) to
turn engine strings like `memory access out of bounds` / `Aborted()` into an
explanation, and shown in the viewer's `#loadError` panel. Files larger than
`MAX_LAYOUT_BYTES` (2 GB) are refused by the extension host before they're
even read, since the raw bytes alone have to be copied into that same heap.

Note that `#ui` — the engine readout — lives inside the debug panel, which is
closed unless the debug command opened it, so it must never be the only place
an error is written.

The hierarchy tree (`build_hierarchy` in `renderer.cpp`) is sized by the
*library*, not by the flattened design: one JS object and one memoized bounding
box per cell in the file, regardless of how many times each cell is placed. So
it costs a fraction of the flatten that follows it, and `kMaxHierarchyCells`
(50,000) is a guard against pathological generated libraries rather than a
limit real designs approach — past it the tree is omitted and the panel says
why, since describing a library that large costs more than the geometry the
tree exists to navigate.

The one exception is each row's `placements` array — the transform of every
individual copy, which the viewer outlines one by one when a row is selected.
That *is* per-placement data, so it carries its own two ceilings:
`kMaxRowPlacements` (1,024 per row) and `kMaxHierarchyPlacements` (200,000 across
the library, spent in cell order). Both are checked before `get_offsets()`
expands an arrayed reference, since a single AREF can hold millions of copies;
a row that hits either keeps only its spanning box and the viewer falls back to
outlining that.

## Publishing

The extension goes to two registries: the **VS Code Marketplace** (VS Code
proper) and **Open VSX** (Cursor, Windsurf, VSCodium, code-server, Gitpod,
Theia). Both should ship the same build.

### One-time setup

Copy [`.env.publish.example`](.env.publish.example) to `.env.publish` and fill
in both tokens. That file is gitignored and excluded from the packaged `.vsix`
via `.vscodeignore`; `scripts/with-env.sh` loads it so no token ever lands in
shell history.

- `VSCE_PAT` — an Azure DevOps personal access token, scoped **Marketplace →
  Manage**, with organization set to **All accessible organizations**. Azure
  caps PAT lifetime at one year, so this expires and has to be reissued.

  > **Deadline: 1 December 2026.** Azure DevOps retires *global* PATs on that
  > date — and "All accessible organizations" is exactly what makes this one
  > global, so `VSCE_PAT` publishing stops working then. See
  > [Migrating off `VSCE_PAT`](#migrating-off-vsce_pat) below. `OVSX_PAT` is an
  > Eclipse token and is unaffected.
- `OVSX_PAT` — from your open-vsx.org profile. Before the first publish you
  must sign the Eclipse Publisher Agreement (with an Eclipse account whose
  email matches your GitHub account) and claim the namespace, which has to
  match `publisher` in `package.json`:

  ```sh
  sh scripts/with-env.sh npx ovsx create-namespace ethml
  ```

  The namespace starts unverified, which shows a warning on the listing;
  ownership verification is requested via an issue on the
  `EclipseFdn/open-vsx.org` repo.

### Releasing

Bump `version` in `package.json`, update `CHANGELOG.md`, rebuild the wasm
(`npm run build:wasm` — `src/wasm/build/` is gitignored, so the `.vsix` is
packaged from whatever is on your disk and a stale build ships silently), then:

```sh
npm run package       # -> GDS-Lens-<version>.vsix
npm run publish:all   # package + both registries
```

`publish:vsce` and `publish:ovsx` can be run individually; both publish the
prebuilt `GDS-Lens-<version>.vsix` rather than repackaging, so the two
registries get byte-identical artifacts.

Marketplace metadata (`displayName`, `description`, `categories`, `keywords`,
`galleryBanner`) only takes effect on the next publish — editing it without
shipping a new version changes nothing on the listing.

### Migrating off `VSCE_PAT`

Global PATs stop working on 1 December 2026. Two replacements exist; only the
Marketplace side is affected, so Open VSX keeps using `OVSX_PAT` either way.

**`vsce publish --oidc` — the intended target, but NOT YET RELEASED.** As of
vsce 3.9.2 this flag does not exist (`unknown option '--oidc'`); it is
documented only on the vsce `main` branch README. Re-check with
`npx @vscode/vsce publish --help | grep oidc` before planning around it.

When it ships, it publishes from GitHub Actions with no stored Marketplace
secret at all: the workflow requests a GitHub OIDC token for the
`marketplace.visualstudio.com` audience and exchanges it for a short-lived
credential. Setup is a trusted-publishing policy on the Marketplace naming this
repo and workflow, plus `id-token: write` on the job:

```yaml
permissions:
  contents: read
  id-token: write
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: 22
  - run: npm ci
  - run: npx @vscode/vsce publish --oidc
```

It deliberately does *not* fall back to a PAT if the exchange fails. The
tradeoff is that releases must run in CI — `--oidc` cannot work from a laptop,
since there is no Actions token to exchange. Note that moving releases into CI
is not just a matter of swapping the auth flag: `src/wasm/build/` is gitignored,
so a CI runner has no bundle to package and would need the Emscripten SDK
installed to build one.

**`vsce publish --azure-credential`.** Available today, and the only documented
replacement. Entra ID via workload identity federation: an Azure DevOps service
connection, a user-assigned managed identity in Azure with a Reader role,
federated credentials exchanged between the two, the identity added as a
Contributor member of the Marketplace publisher, and an Azure Pipelines job that
mints an Entra token. It assumes an Azure subscription and Azure Pipelines,
neither of which this project uses — disproportionate for a solo extension.

**Plan of record:** stay on `VSCE_PAT` for now, and re-check `--oidc` around
Q3 2026. Microsoft needs a GitHub Actions story before retiring PATs on
1 December 2026, and `--oidc` already exists on `main`, so it is very likely to
ship in time. If it has not shipped by ~November 2026, fall back to
`--azure-credential`.

## Linting

`npm run lint` (`eslint .`). Clean means clean: the config reports nothing on
the tree as it stands, so anything it prints is new.

The config is split per environment rather than applied as one block, because
this tree holds four of them and `no-undef` is only worth having if it knows
which one a file is in — the webview's `<script>` files (browser globals plus
whatever the tags before them defined), the parse Worker (no DOM), the
extension host (worker globals, *not* Node's, so a `Buffer` or `process` that
would break on the web is caught here) and the unit tests (CommonJS under Node,
free to use `Buffer` and `zlib` to build fixtures). Two things it skips:
`src/wasm/build/` (Emscripten's generated output) and `src/vendor/`
(a minified upstream lil-gui), neither of which is ours to fix.

A leading underscore marks an argument required by a signature but unused —
what the VS Code API's providers are handed — and the config ignores those.
