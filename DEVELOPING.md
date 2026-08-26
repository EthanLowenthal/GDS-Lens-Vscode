# Developing GDS Lens

Developer documentation for building and hacking on the extension. For usage,
see [`README.md`](README.md).

## Project layout

This repo is the VS Code shell only. Everything that parses and draws a layout
lives in [gds-lens](https://github.com/EthanLowenthal/GDS-Lens) and is consumed
from there as a package.

- `src/extension.cjs` - the extension host, and the only source file left here.
  Opens the layout file (`.gds` / `.oas` / `.oasis`, optionally gzipped),
  streams its bytes into the webview, and relays the `.lyp` and marker file
  pickers. Uses no Node builtins, so the one bundle serves both the desktop
  host and the Web Worker host: see "Running on the web" below.
- `src/webview-host.js` - the whole of what the viewer knows about VS Code. The
  library defines a `ViewerHost` interface for the things only an embedder can
  do (pick a file, prompt for a name, persist views, request a reload) and ships
  a default implementation for a plain web page; this replaces that one file at
  build time. See "The host adapter" below.
- `scripts/copy-webview.mjs` - copies the viewer payload out of the `gds-lens`
  package into `dist/webview/`, which is what the host points the webview at.
  Copying rather than reaching into `node_modules/` through `asWebviewUri`
  keeps `localResourceRoots` and `.vscodeignore` simple, and keeps
  `node_modules` out of the `.vsix` entirely. It takes the library's
  `inline-wasm` payload rather than its default `web` one; see "Why the wasm is
  embedded" below.
- `test/fixtures/` - sample layouts and marker databases, kept here for
  `npm run test:web`. The unit tests moved to the library with the code they
  cover.

What the host still imports directly from the library, rather than through the
webview, is the pair of pure modules that run in the extension host itself:
`gds-lens/layout-bytes` (gzip expansion, see "Layout size limits" below) and
`gds-lens/coord-parse` (reading an `x, y` pair out of pasted text). Both are
DOM-free and wasm-free, which is why they can be required here at all. esbuild
inlines them into `dist/extension.js` at build time, so `gds-lens` is a
devDependency: nothing needs it at runtime.

## The host adapter

The viewer is a `<gds-lens>` custom element that never touches its environment
directly. It asks a host object for anything only an embedder can do, and the
host drives it back through the surface `connect()` hands over. The library's
own default host implements that for a plain page (`<input type=file>`,
`localStorage`, `prompt()`); `src/webview-host.js` implements it for VS Code
and is copied over the default as `host.js`.

Three parts of it are worth knowing about, because each exists for a reason
that is not obvious:

- **The pickers are promises over a one-way protocol.** The extension host
  speaks in messages that do not pair up: a request goes out as one and its
  answer arrives as a different one, with nothing connecting them. The adapter
  keeps a resolver per outstanding request. Answers can also arrive
  *unsolicited* (a `.lyp` remembered from a previous session is pushed on open),
  so an answer nobody asked for is pushed into the viewer instead.
- **`createWorker()` inlines the parse Worker's script.** A webview cannot
  reach its own asset URLs from inside a Worker: neither `importScripts()` nor
  `fetch()` reaches the resource protocol, even though the identical URL loads
  fine as a `<script src>` tag. So the extension host base64s the worker's whole
  script into `#workerBundle` in the outer document and the adapter builds the
  Worker from that.
- **`isLightTheme()` maps VS Code's theme classes.** VS Code stamps
  `vscode-light` / `vscode-dark` / `vscode-high-contrast[-light]` onto `<body>`
  and rewrites it live. The viewer only wants a boolean, so the mapping lives on
  this side of the seam.

Two things the extension host does to the payload's HTML at serve time:
`<script src="name.js">` is rewritten to a webview URI (generically, by pattern
rather than a hand-written list, so a file added to the payload cannot be
silently forgotten), and `script-src 'self'` is rewritten to the webview's own
resource origin.

## Building

There is no Emscripten dependency here any more. The wasm module is built in
the library repo and arrives prebuilt.

```sh
npm install
npm run compile      # copy dist/webview/ from gds-lens, then bundle the host
```

`npm run package` does this for you via `vscode:prepublish`.

### Why the wasm is embedded

`gds-lens` builds two payloads. Its default, `dist/web/`, ships `gdstk_wasm.js`
plus a separate `gdstk_wasm.wasm` that the JS fetches.

A webview cannot fetch it. Its resource protocol (`vscode-cdn.net`) serves
`<script src>` tags in the main document fine, but nothing else reaches it:
`fetch()` against one of those URLs fails from the main thread, and a Worker
(even a blob one) cannot even `importScripts()` from it.

So `scripts/copy-webview.mjs` takes `dist/inline-wasm/` instead:
`-sSINGLE_FILE=1`, binary embedded in `gdstk_wasm.js`, nothing to fetch. It is
a few KB larger over the wire and gives up streaming compilation.

The same constraint is why the parse Worker's script is assembled by hand
rather than loaded: `createWorker` in `src/webview-host.js` reads the
concatenated `gdstk_wasm.js` + `wasm-worker.js` text out of the
`#workerBundle` element in `viewer.html` and builds a blob from it.

## Working on the library at the same time

`gds-lens` is pinned to an exact published version, so what builds here is what
users get, and a release cannot pick up an unpublished local edit. To work on
both at once, point npm at the sibling checkout for the duration:

```sh
npm link ../GDS-Lens          # node_modules/gds-lens -> ../GDS-Lens
npm unlink --no-save gds-lens && npm ci   # back to the pinned version
```

`npm ls gds-lens` says which one is in effect: a path means the link is live.
Do not commit a `package.json` pointing at `file:../GDS-Lens`.

With the link in place the inner loop is two watchers, one per repo:

```sh
# terminal 1, in ../GDS-Lens
npm run watch        # rebuilds its payloads on every source edit

# terminal 2, here
npm run watch        # re-copies dist/webview, then esbuild --watch on the host
```

Then reload the Extension Development Host window to pick up webview changes.

Two things this loop deliberately does not cover. Changing any `src/wasm/*.cpp`
in the library means re-running `npm run build:wasm` there, which is emcc and
far too slow to trigger on keystrokes. And the extension's own `npm run watch`
copies `dist/webview/` once at startup rather than watching it, so a library
edit needs `npm run build:webview` here (or a restart) to cross over.

Before releasing, unlink and `npm ci`, so a broken publish fails here rather
than on the Marketplace.

### Bumping the library

The pin is exact on purpose. The payload filenames are part of the contract
this repo depends on (`src/extension.cjs` looks up `gds-lens.html`,
`gds-lens-engine.js` and `gds-lens-worker.js` by name), and nothing verifies
them at build time - the 0.1.0 rename broke exactly this and did so silently,
with a 404 and a viewer stuck on its loading bar. From 1.0.0 the element's API
is under semver, but the served payload's filenames are not called out as part
of it, so bump deliberately:

```sh
npm install --save-dev --install-links gds-lens@<version>
npm run compile && npm run package
```

then open a layout in the Extension Development Host before tagging.

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

Almost all of the viewer was already portable - the wasm module is built with
`-sSINGLE_FILE` so there is no binary to fetch (see below), and the webview and
its parse Worker were always browser code. The
extension host was the part that wasn't, and it stays portable only by using
no Node builtins at all:

- **No `fs`/`path`.** File access goes through `vscode.workspace.fs` and
  locations through `vscode.Uri`. In particular `uri.fsPath` is avoided for
  anything but backwards compatibility: a layout opened from github.dev is a
  `vscode-vfs:` URI with no filesystem path behind it. That is also why the
  remembered `.lyp`/marker locations and the per-layout state maps are keyed by
  `uri.toString()`, with a fallback read of the old `fsPath` keys so state
  written before the port survives.
- **No `zlib`.** `gds-lens/layout-bytes` expands gzipped layouts with
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

One difference is not in the code and not in the environment either, and it is
worth knowing about because `npm run test:web` cannot see it. `asWebviewUri`
returns an `http`/`https` URI untouched - the browser can already load it - so
on the web the webview's scripts come from wherever the extension itself is
served from, not from VS Code's resource origin. On the real vscode.dev that is
`https://<publisher>.vscode-unpkg.net`, an origin `webview.cspSource` says
nothing about, so the CSP has to name it as well or every script in the payload
is blocked and the editor opens blank. Under `test:web` the extension and the
webview are served from the same `localhost` origin, which `'self'` covers on
its own, so a CSP missing that origin passes locally and fails only once
installed from the Marketplace. Anything else that depends on those two being
separate origins has the same blind spot; the only real check is installing a
published build on vscode.dev.

## Layout size limits

Parsing, flattening and triangulating all happen inside a 32-bit WebAssembly
module, so everything has to fit in one 4 GB address space
(`-sMAXIMUM_MEMORY` in the library's `src/wasm/CMakeLists.txt`, Emscripten's default being
only 2 GB). What that buys, measured against generated stress layouts:

- **Flat geometry is the expensive case.** ~1 KB per polygon end to end
  (gdstk polygon + triangulated vertices + the typed arrays handed to JS), so
  a couple of million top-level polygons is the practical ceiling.
- **Hierarchy is nearly free.** A cell placed at least `kInstanceThreshold`
  (8) times anywhere in the design becomes a GPU instance batch - 24 bytes per
  placement instead of a full geometry copy. A hierarchy that flattens to
  115M polygons loads in ~2 GB; the same 4 GB budget is exhausted somewhere
  under 1G.

A gzipped layout is expanded before any of this, in the extension host
(`gds-lens/layout-bytes`), and the ceilings above apply to what it expands *to*,
which is also what `MAX_LAYOUT_BYTES` is checked against for a `.gz`, rather
than its size on disk. Expanding it in Node rather than inside the wasm module
is the whole point: the module would have to hold the compressed bytes and the
expanded bytes at once, in the one 4 GB address space that already has to fit
the flattened geometry, whereas the host's heap has neither constraint.
`DecompressionStream` is what expands it (not Node's `zlib`, which the web
extension host does not have), so the cap is enforced by counting bytes as
they arrive: a small archive claiming to expand to 40 GB is stopped as it
overruns rather than after it has allocated.

Past that the module aborts. The abort is a JS throw, so it's caught in
the library's `wasm-worker.js`, run through `describeLoadFailure` to
turn engine strings like `memory access out of bounds` / `Aborted()` into an
explanation, and shown in the viewer's `#loadError` panel. Files larger than
`MAX_LAYOUT_BYTES` (2 GB) are refused by the extension host before they're
even read, since the raw bytes alone have to be copied into that same heap.

Note that `#ui` - the engine readout - lives inside the debug panel, which is
closed unless the debug command opened it, so it must never be the only place
an error is written.

The hierarchy tree (`build_hierarchy` in `renderer.cpp`) is sized by the
*library*, not by the flattened design: one JS object and one memoized bounding
box per cell in the file, regardless of how many times each cell is placed. So
it costs a fraction of the flatten that follows it, and `kMaxHierarchyCells`
(50,000) is a guard against pathological generated libraries rather than a
limit real designs approach - past it the tree is omitted and the panel says
why, since describing a library that large costs more than the geometry the
tree exists to navigate.

The one exception is each row's `placements` array - the transform of every
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

- `VSCE_PAT` - an Azure DevOps personal access token, scoped **Marketplace →
  Manage**, with organization set to **All accessible organizations**. Azure
  caps PAT lifetime at one year, so this expires and has to be reissued.

  > **Deadline: 1 December 2026.** Azure DevOps retires *global* PATs on that
  > date - and "All accessible organizations" is exactly what makes this one
  > global, so `VSCE_PAT` publishing stops working then. See
  > [Migrating off `VSCE_PAT`](#migrating-off-vsce_pat) below. `OVSX_PAT` is an
  > Eclipse token and is unaffected.
- `OVSX_PAT` - from your open-vsx.org profile. Before the first publish you
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

Bump `version` in `package.json`, update `CHANGELOG.md`, make sure the
`gds-lens` build you are packaging against is current (`npm run compile` copies
whatever is in that package's `dist/inline-wasm/`, so a stale library build
ships silently), then:

```sh
npm run package       # -> GDS-Lens-<version>.vsix
npm run publish:all   # package + both registries
```

`publish:vsce` and `publish:ovsx` can be run individually; both publish the
prebuilt `GDS-Lens-<version>.vsix` rather than repackaging, so the two
registries get byte-identical artifacts.

Marketplace metadata (`displayName`, `description`, `categories`, `keywords`,
`galleryBanner`) only takes effect on the next publish - editing it without
shipping a new version changes nothing on the listing.

### Migrating off `VSCE_PAT`

Global PATs stop working on 1 December 2026. Two replacements exist; only the
Marketplace side is affected, so Open VSX keeps using `OVSX_PAT` either way.

**`vsce publish --oidc` - the intended target, but NOT YET RELEASED.** As of
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
tradeoff is that releases must run in CI - `--oidc` cannot work from a laptop,
since there is no Actions token to exchange. Note that moving releases into CI
is not just a matter of swapping the auth flag: the viewer payload comes from
the `gds-lens` package, so a CI runner needs that package installed from the
registry rather than from the local `file:` path used in development.

**`vsce publish --azure-credential`.** Available today, and the only documented
replacement. Entra ID via workload identity federation: an Azure DevOps service
connection, a user-assigned managed identity in Azure with a Reader role,
federated credentials exchanged between the two, the identity added as a
Contributor member of the Marketplace publisher, and an Azure Pipelines job that
mints an Entra token. It assumes an Azure subscription and Azure Pipelines,
neither of which this project uses - disproportionate for a solo extension.

**Plan of record:** stay on `VSCE_PAT` for now, and re-check `--oidc` around
Q3 2026. Microsoft needs a GitHub Actions story before retiring PATs on
1 December 2026, and `--oidc` already exists on `main`, so it is very likely to
ship in time. If it has not shipped by ~November 2026, fall back to
`--azure-credential`.

## Linting

`npm run lint` (`eslint .`). Clean means clean: the config reports nothing on
the tree as it stands, so anything it prints is new.

The config is split per environment rather than applied as one block, because
`no-undef` is only worth having if it knows which one a file is in. Two remain
here now that the viewer has moved out: the extension host (worker globals,
*not* Node's, so a `Buffer` or `process` that would break on the web is caught
here) and the build scripts under `scripts/` (real Node, ESM, never shipped).
The webview, Worker and parser blocks live in the library's own config. It
skips `dist/`, which is
esbuild's bundle of our own sources plus the viewer payload copied out of
`gds-lens`: linting it would only ever report the same thing twice, or report
someone else's code.

A leading underscore marks an argument required by a signature but unused -
what the VS Code API's providers are handed - and the config ignores those.
