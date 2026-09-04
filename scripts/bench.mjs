#!/usr/bin/env node
// Loads layouts headlessly with the same wasm module the extension ships and
// prints how long each took and what it held -- the figures the README's
// Performance section quotes, so they can be refreshed per release:
//
//   npm run bench -- path/to/chip.gds another.oas.gz ...
//
// Each file is read, gunzipped if its first two bytes say so (the extension
// host does the same before the bytes reach wasm -- see gds-lens/layout-bytes),
// written into the module's MEMFS and handed to parseGdsToLayers, which is the
// parse + flatten + triangulate half of a load. Drawing is not measured: it
// needs a GPU, and on a real load it is the smaller part (uploadLayers copies
// the vertex arrays into GL buffers and the first frame follows).
//
// Every file gets a fresh module so the numbers are independent; the memory
// column is how much the process's resident size grew across that file's load,
// module creation included.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);

// The inline build embeds the .wasm in the .js, so one file is the whole
// module -- the same one dist/webview is copied from (see copy-webview.mjs).
// The package's exports map does not list dist/, so resolve it from
// package.json, as copy-webview.mjs does.
const pkgDir = path.dirname(require.resolve("gds-lens/package.json"));
const enginePath = path.join(pkgDir, "dist", "inline-wasm", "gds-lens-engine.js");
const pkgVersion = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;

// gds-lens-engine.js is Emscripten MODULARIZE output: it defines
// createGdstkModule in its own scope rather than exporting it, and calls
// require() when it detects Node, so it is eval'd with those names in hand.
async function loadModule() {
    const src = fs.readFileSync(enginePath, "utf8");
    const scope = {};
    new Function("scope", "require", "__dirname", "__filename",
        src + "\nscope.createGdstkModule = createGdstkModule;")(
        scope, require, path.dirname(enginePath), enginePath);
    return scope.createGdstkModule({});
}

function fmtBytes(n) {
    if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`;
    if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${n} B`;
}

function fmtCount(n) {
    return Number(n).toLocaleString("en-US");
}

async function benchOne(file) {
    let bytes = fs.readFileSync(file);
    const onDisk = bytes.length;
    const gzipped = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
    if (gzipped) bytes = zlib.gunzipSync(bytes);

    // The module does not export its heap views, so memory is read off the
    // process instead: resident size before the module is created and after
    // the parse. That includes the JS side's copy of the typed arrays, which
    // is also what a real load holds, and is an approximation either way.
    const rssBefore = process.memoryUsage().rss;
    const Module = await loadModule();
    Module.FS.writeFile("/input.layout", new Uint8Array(bytes));
    const t0 = performance.now();
    const result = Module.parseGdsToLayers("/input.layout");
    const ms = performance.now() - t0;
    Module.FS.unlink("/input.layout");
    if (!result.ok) return { file, error: result.error };

    let staticPolygons = 0, instancedCells = 0, placements = 0;
    for (const group of result.instanceGroups) {
        instancedCells++;
        placements += group.instances.length / 6;
    }
    staticPolygons = Number(result.totalPolygons);
    return {
        file,
        format: result.format,
        onDisk,
        expanded: bytes.length,
        gzipped,
        ms,
        layers: result.layers.length,
        cells: result.hierarchy.cellCount,
        polygons: staticPolygons,
        instancedCells,
        placements,
        labels: Number(result.totalLabels),
        ports: result.hierarchy.portCount || 0,
        heap: Math.max(0, process.memoryUsage().rss - rssBefore)
    };
}

const files = process.argv.slice(2);
if (files.length === 0) {
    console.error("usage: npm run bench -- <layout file>...");
    process.exit(2);
}

const rows = [];
for (const file of files) {
    process.stderr.write(`${file} ... `);
    try {
        rows.push(await benchOne(file));
        process.stderr.write("done\n");
    } catch (err) {
        rows.push({ file, error: err && err.message ? err.message : String(err) });
        process.stderr.write("failed\n");
    }
}

console.log("| File | Size | Format | Parse + triangulate | Polygons | Instanced cells / placements | Cells | Layers | Memory growth |");
console.log("| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const r of rows) {
    const name = path.basename(r.file);
    if (r.error) {
        console.log(`| ${name} | | | failed: ${r.error} | | | | | |`);
        continue;
    }
    const size = r.gzipped ? `${fmtBytes(r.onDisk)} (${fmtBytes(r.expanded)} expanded)` : fmtBytes(r.onDisk);
    const secs = r.ms >= 1000 ? `${(r.ms / 1000).toFixed(2)} s` : `${r.ms.toFixed(0)} ms`;
    console.log(`| ${name} | ${size} | ${r.format} | ${secs} | ${fmtCount(r.polygons)} | ` +
                `${fmtCount(r.instancedCells)} / ${fmtCount(r.placements)} | ${fmtCount(r.cells)} | ` +
                `${r.layers} | ${fmtBytes(r.heap)} |`);
}
console.log();
console.log(`node ${process.version}, ${process.arch}, gds-lens ${pkgVersion}. ` +
            "Polygons are what is drawn statically after the flatten; instanced cells are drawn once per placement on the GPU.");
