// Headless test for the GDSII/OASIS reader dispatch in gds_common.hpp: evals
// the built gdstk_wasm.js in plain Node (no GL context needed -- this only
// exercises parseGdsToLayers's CPU half) and parses the same design saved in
// both formats, asserting the format is sniffed from the file header and that
// the two produce identical flattened geometry.
//
// fixtures/sample_layout.{gds,oas} are two writes of one KLayout-built layout:
// a 10x5um box on layer 1/0 in TOP, plus a 2x1um box on layer 2/0 in CHILD
// placed twice standalone and once as a 3x2 array (6) -- 8 CHILD placements
// in all.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { decodeLayoutBytes } = require("../src/layout-bytes.js");

const wasmJsPath = path.join(__dirname, "..", "src", "wasm", "build", "gdstk_wasm.js");
const wasmBuilt = fs.existsSync(wasmJsPath);
const skip = !wasmBuilt && "src/wasm/build/gdstk_wasm.js not built";

// Same eval-the-bundle trick as marker-wasm.test.js (MODULARIZE + SINGLE_FILE).
async function loadModule() {
    const src = fs.readFileSync(wasmJsPath, "utf8");
    const scope = {};
    new Function("scope", "require", "__dirname", "__filename",
        src + "\nscope.createGdstkModule = createGdstkModule;")(
        scope, require, path.dirname(wasmJsPath), wasmJsPath);
    return scope.createGdstkModule({});
}

// Stages bytes into MEMFS under an extension-less name (exactly like
// wasm-worker.js does) so nothing but the file's own header can decide the
// format, and parses them.
function parseBytes(Module, bytes) {
    Module.FS.writeFile("/input.layout", new Uint8Array(bytes));
    try {
        return Module.parseGdsToLayers("/input.layout");
    } finally {
        Module.FS.unlink("/input.layout");
    }
}

function parseFixture(Module, fixtureName) {
    return parseBytes(Module, fs.readFileSync(path.join(__dirname, "fixtures", fixtureName)));
}

// parseGdsToLayers splits a design into static per-layer geometry plus one
// instance group per repeatedly-placed cell, and the two are keyed by
// unordered maps -- so compare a canonical summary rather than raw ordering.
function summarize(result) {
    const layerSummary = (layer) => ({
        layer: layer.layer,
        polygons: layer.polygonCount,
        outlineVertices: layer.outlineVertices.length,
        fillVertices: layer.fillVertices.length,
    });
    const byLayer = (a, b) => a.layer - b.layer;
    return {
        layers: result.layers.map(layerSummary).sort(byLayer),
        instanceGroups: result.instanceGroups
            .map((group) => ({
                // 6 floats per instance (2x3 affine).
                instances: group.instances.length / 6,
                layers: group.layers.map(layerSummary).sort(byLayer),
            }))
            .sort((a, b) => a.instances - b.instances),
        bbox: result.bbox,
        totalPolygons: result.totalPolygons,
    };
}

test("parses GDSII and OASIS, detecting the format from the header", { skip }, async () => {
    const Module = await loadModule();

    const gds = parseFixture(Module, "sample_layout.gds");
    assert.strictEqual(gds.ok, true, gds.error);
    assert.strictEqual(gds.format, "GDSII");

    const oas = parseFixture(Module, "sample_layout.oas");
    assert.strictEqual(oas.ok, true, oas.error);
    assert.strictEqual(oas.format, "OASIS");

    // Both readers run with unit=1e-6, so coordinates land in microns either
    // way: TOP's box spans 10x5um from the origin, and the 3x2 array's top row
    // sits at y=12um and is 1um tall, putting the design's ceiling at 13um.
    assert.deepStrictEqual(oas.bbox, {minX: 0, maxX: 10, minY: 0, maxY: 13});
    assert.deepStrictEqual(summarize(oas), summarize(gds));

    // 1 box in TOP + 8 CHILD placements of 1 box each. (uint64 on the C++
    // side, so embind hands it back as a BigInt.)
    assert.strictEqual(oas.totalPolygons, 9n);
});

// The cell tree the viewer's hierarchy panel is built from (build_hierarchy in
// renderer.cpp): structure only -- names, child lists, placement counts and
// boxes -- alongside the flattened geometry the same parse produces.
test("describes the cell hierarchy, collapsing an AREF into one child entry", { skip }, async () => {
    const Module = await loadModule();

    // The placements of one child entry (6 doubles each, laid out like
    // Affine2D), as a sorted set of strings: the two fixtures are two writes of
    // one design and list TOP's three references to CHILD in different orders,
    // so the placements are the same eight in either file but not necessarily in
    // the same order.
    const placementSet = (ref) => {
        if (!ref.placements) return null;
        const out = [];
        for (let i = 0; i < ref.placements.length; i += 6) {
            out.push(Array.from(ref.placements.slice(i, i + 6)).join(","));
        }
        return out.sort();
    };

    // Everything except each child entry's xform, which is the *first*
    // placement's transform -- and which of the eight copies that is
    // legitimately differs between the two files, for the reason above.
    const structure = (hierarchy) => ({
        cellCount: hierarchy.cellCount,
        omitted: hierarchy.omitted,
        roots: hierarchy.roots,
        cells: hierarchy.cells.map((cell) => ({
            name: cell.name,
            polygons: cell.polygons,
            labels: cell.labels,
            bbox: cell.bbox,
            refs: cell.refs.map((ref) => ({
                cell: ref.cell, count: ref.count, bbox: ref.bbox, placements: placementSet(ref),
            })),
        })),
    });

    const gds = parseFixture(Module, "sample_layout.gds");
    assert.strictEqual(gds.ok, true, gds.error);
    const hierarchy = gds.hierarchy;

    assert.strictEqual(hierarchy.cellCount, 2);
    assert.strictEqual(hierarchy.omitted, false);
    assert.strictEqual(hierarchy.roots.length, 1);

    const top = hierarchy.cells[hierarchy.roots[0]];
    assert.strictEqual(top.name, "TOP");
    assert.strictEqual(top.polygons, 1);
    // A top cell's own frame is world space, so its box is the design's.
    assert.deepStrictEqual(top.bbox, gds.bbox);

    // TOP places CHILD three times -- twice standalone and once as a 3x2 array
    // -- which is one child entry standing for 8 placements, not three entries
    // or eight.
    assert.strictEqual(top.refs.length, 1);
    const child = top.refs[0];
    assert.strictEqual(child.count, 8);
    // Spans every one of those 8 placements, in TOP's coordinates: the pair of
    // standalone 2x1um boxes plus the array reaching x=8um and y=13um.
    assert.deepStrictEqual(child.bbox, {minX: 0, maxX: 8, minY: 6, maxY: 13});
    // The first placement's transform, as [a, b, c, d, tx, ty]: nothing in this
    // fixture is rotated or mirrored, so the linear part is the identity (the
    // +0 normalizes the -0 that the sin(0) term leaves in b).
    assert.deepStrictEqual(child.xform.slice(0, 4).map((v) => v + 0), [1, 0, 0, 1]);

    const leaf = hierarchy.cells[child.cell];
    assert.strictEqual(leaf.name, "CHILD");
    assert.deepStrictEqual(leaf.refs, []);
    // In CHILD's own frame, which is what makes the same entry reusable for
    // every parent that places it.
    assert.deepStrictEqual(leaf.bbox, {minX: 0, maxX: 2, minY: 0, maxY: 1});

    // The entry also carries all 8 placements individually, which is what lets
    // the viewer outline each copy of CHILD where it actually sits instead of
    // drawing one rectangle around the lot (see hierarchyBoxes in viewer.js).
    assert.strictEqual(child.placements.constructor, Float64Array);
    assert.strictEqual(child.placements.length, 8 * 6);

    // Mapping CHILD's own box through each of them and unioning the results
    // gives back exactly the entry's spanning box -- so the copies account for
    // the whole of it, including the one placed with a 90 degree rotation, whose
    // 2x1um box lands 1x2um.
    const union = {minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity};
    for (let i = 0; i < child.placements.length; i += 6) {
        const [a, b, c, d, tx, ty] = Array.from(child.placements.slice(i, i + 6));
        for (const [x, y] of [[leaf.bbox.minX, leaf.bbox.minY], [leaf.bbox.maxX, leaf.bbox.minY],
                              [leaf.bbox.minX, leaf.bbox.maxY], [leaf.bbox.maxX, leaf.bbox.maxY]]) {
            const wx = a * x + b * y + tx;
            const wy = c * x + d * y + ty;
            union.minX = Math.min(union.minX, wx);
            union.maxX = Math.max(union.maxX, wx);
            union.minY = Math.min(union.minY, wy);
            union.maxY = Math.max(union.maxY, wy);
        }
    }
    for (const key of ["minX", "maxX", "minY", "maxY"]) {
        // Not exact: the rotated copy's corners go through sin/cos.
        assert.ok(Math.abs(union[key] - child.bbox[key]) < 1e-9,
                  `placement union ${key}: ${union[key]} vs ${child.bbox[key]}`);
    }

    const oas = parseFixture(Module, "sample_layout.oas");
    assert.strictEqual(oas.ok, true, oas.error);
    assert.deepStrictEqual(structure(oas.hierarchy), structure(hierarchy));
});

// The .gds.gz path end to end, minus VS Code: the extension host's
// decodeLayoutBytes (src/layout-bytes.js) is what turns a compressed file into
// the bytes the Worker stages into MEMFS, so the two halves are only correct
// together. In particular the format sniffing happens *after* decompression --
// the gzip header would otherwise be all either reader ever saw -- so this
// covers both formats rather than just GDSII.
test("parses a gzipped layout identically to the same file uncompressed", { skip }, async () => {
    const Module = await loadModule();
    const MAX = 2 * 1024 * 1024 * 1024;  // MAX_LAYOUT_BYTES in extension.cjs

    for (const [fixture, expectedFormat] of [["sample_layout.gds", "GDSII"],
                                             ["sample_layout.oas", "OASIS"]]) {
        const plain = fs.readFileSync(path.join(__dirname, "fixtures", fixture));
        const decodedPlain = await decodeLayoutBytes(plain, MAX);
        const decodedGz = await decodeLayoutBytes(zlib.gzipSync(plain), MAX);

        assert.strictEqual(decodedPlain.gzipped, false, fixture);
        assert.strictEqual(decodedGz.gzipped, true, fixture);
        assert.deepStrictEqual(Buffer.from(decodedGz.bytes), plain, `${fixture}: round trip`);

        const fromPlain = parseBytes(Module, decodedPlain.bytes);
        const fromGz = parseBytes(Module, decodedGz.bytes);
        assert.strictEqual(fromGz.ok, true, fromGz.error);
        // Still decided by the file's own header, not by the .gz wrapper.
        assert.strictEqual(fromGz.format, expectedFormat);
        assert.deepStrictEqual(summarize(fromGz), summarize(fromPlain), `${fixture}: geometry`);
    }
});

test("rejects a file that is neither GDSII nor OASIS", { skip }, async () => {
    const Module = await loadModule();

    Module.FS.writeFile("/input.layout", new TextEncoder().encode("not a layout file\n"));
    const result = Module.parseGdsToLayers("/input.layout");
    Module.FS.unlink("/input.layout");

    // No OASIS magic, so it falls through to the GDSII reader, which rejects
    // it (as a truncated record stream -- InputFileError, before it ever gets
    // to a header check) rather than the caller getting an empty render.
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.length > 0);
});
