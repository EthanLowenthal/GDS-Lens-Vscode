// Copies the viewer payload out of the gds-lens package into dist/webview,
// which is what src/extension.cjs points the webview at.
//
// gds-lens builds two payloads. This takes inline-wasm, where the binary is
// embedded in gdstk_wasm.js, rather than the default web one that fetches a
// separate .wasm: a webview cannot reach its own asset URLs, from a Worker or
// from the main thread, so there is nothing here to fetch it with.
//
// Copying rather than reaching into node_modules/ through asWebviewUri keeps
// localResourceRoots and .vscodeignore simple: everything the webview loads
// lives under dist/, and node_modules never has to ship inside the .vsix.

import { cp, copyFile, access, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const pkg = dirname(require.resolve("gds-lens/package.json"));
const from = join(pkg, "dist", "inline-wasm");
const to = join(root, "dist", "webview");

try {
    await access(from);
} catch {
    console.error(
        `gds-lens has no built inline-wasm payload at ${from}.\n` +
        "Build it there first: (cd ../GDS-Lens && npm run build:wasm && npm run build)"
    );
    process.exit(1);
}

await rm(to, { recursive: true, force: true });
await cp(from, to, { recursive: true });

// The library ships a host.js implementing its ViewerHost interface for a
// plain web page: an <input type=file> for the pickers, localStorage for saved
// views, prompt() for a name. None of that is right inside a webview, where
// those services belong to the extension host, so ours replaces it. This one
// substitution is the entire VS Code-specific part of the viewer.
await copyFile(join(root, "src", "webview-host.js"), join(to, "host.js"));

console.log(`dist/webview <- ${from} (host.js <- src/webview-host.js)`);
