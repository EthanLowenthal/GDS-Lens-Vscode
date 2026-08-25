// Copies the viewer payload out of the gds-lens package into dist/webview,
// which is what src/extension.cjs points the webview at.
//
// Copying rather than reaching into node_modules/ through asWebviewUri keeps
// localResourceRoots and .vscodeignore simple: everything the webview loads
// lives under dist/, and node_modules never has to ship inside the .vsix.

import { cp, access, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const pkg = dirname(require.resolve("gds-lens/package.json"));
const from = join(pkg, "dist", "webview");
const to = join(root, "dist", "webview");

try {
    await access(from);
} catch {
    console.error(
        `gds-lens has no built dist/webview at ${from}.\n` +
        "Build it there first: (cd ../GDS-Lens && npm run build:wasm && npm run build)"
    );
    process.exit(1);
}

await rm(to, { recursive: true, force: true });
await cp(from, to, { recursive: true });
console.log(`dist/webview <- ${from}`);
