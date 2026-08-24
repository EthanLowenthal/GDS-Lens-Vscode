// Unit tests for src/layout-bytes.js -- the gzip expansion the extension host
// does before any layout bytes reach the webview. The size cap and the
// magic-number detection are the parts worth pinning: one is what keeps a small
// .gds.gz from expanding past what the 32-bit wasm heap can hold, and the other
// is what decides whether a file is treated as compressed at all.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const zlib = require("zlib");
const { looksGzipped, gzipStoredSize, decodeLayoutBytes } = require("../src/layout-bytes.js");

// A GDSII header record (length 0x0006, HEADER 0x0002, version 600) followed by
// filler -- enough that the bytes coming back out are identifiably a layout and
// not just any old buffer.
function fakeLayout(bytes = 4096) {
    const buffer = Buffer.alloc(bytes, 0x11);
    buffer.set([0x00, 0x06, 0x00, 0x02, 0x02, 0x58], 0);
    return buffer;
}

test("detects gzip by its magic number, not by length or name", () => {
    assert.ok(looksGzipped(zlib.gzipSync(fakeLayout())));
    assert.ok(looksGzipped(Uint8Array.from([0x1f, 0x8b])));
    assert.ok(!looksGzipped(fakeLayout()));
    assert.ok(!looksGzipped(Uint8Array.from([0x1f])));
    assert.ok(!looksGzipped(Uint8Array.from([])));
    assert.ok(!looksGzipped(null));
});

test("passes uncompressed bytes through untouched and uncopied", async () => {
    const plain = fakeLayout();
    const result = await decodeLayoutBytes(plain, 1024 * 1024);
    assert.equal(result.ok, true);
    assert.equal(result.gzipped, false);
    // The same object, not a copy -- the ordinary path must not duplicate a
    // multi-hundred-megabyte buffer to discover it isn't gzipped.
    assert.strictEqual(result.bytes, plain);
});

test("expands a gzipped layout back to the original bytes", async () => {
    const plain = fakeLayout(64 * 1024);
    const result = await decodeLayoutBytes(zlib.gzipSync(plain), 1024 * 1024);
    assert.equal(result.ok, true);
    assert.equal(result.gzipped, true);
    assert.deepEqual(Buffer.from(result.bytes), plain);
});

// DecompressionStream hands its output back in pieces (16 KB at a time, so
// anything past that arrives as several), which decodeLayoutBytes has to
// reassemble itself -- zlib.gunzipSync used to return one finished buffer. An
// off-by-one in that copy would corrupt layouts silently and only above a size
// threshold, so this pins it with content where a misplaced chunk can't go
// unnoticed: every byte is a function of its own offset, which a repeated
// filler byte would have hidden.
test("reassembles output that arrives in several chunks", async () => {
    const plain = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < plain.length; i++) plain[i] = (i * 31 + (i >> 8)) & 0xff;

    const result = await decodeLayoutBytes(zlib.gzipSync(plain), 8 * 1024 * 1024);
    assert.equal(result.ok, true);
    assert.equal(result.bytes.byteLength, plain.length);
    assert.deepEqual(Buffer.from(result.bytes), plain);
});

// vscode.workspace.fs.readFile hands back a plain Uint8Array rather than a
// Buffer, so nothing here may depend on Buffer-only methods.
test("accepts a plain Uint8Array, not just a Buffer", async () => {
    const plain = fakeLayout();
    const gz = zlib.gzipSync(plain);
    const result = await decodeLayoutBytes(new Uint8Array(gz.buffer, gz.byteOffset, gz.length), 1024 * 1024);
    assert.equal(result.ok, true);
    assert.deepEqual(Buffer.from(result.bytes), plain);
});

test("refuses a layout that expands past the cap", async () => {
    // Highly compressible: a small .gz standing in for the real hazard, which is
    // a file whose size on disk says nothing about what it costs to open.
    const gz = zlib.gzipSync(Buffer.alloc(512 * 1024, 0));
    assert.ok(gz.length < 4096, `expected a small archive, got ${gz.length} bytes`);

    const result = await decodeLayoutBytes(gz, 64 * 1024);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "too-large");
    // The claimed expanded size is what the refusal message quotes.
    assert.equal(result.storedSize, 512 * 1024);
});

test("reports a broken compressed stream separately from an oversized one", async () => {
    const gz = zlib.gzipSync(fakeLayout(64 * 1024));

    const truncated = await decodeLayoutBytes(gz.subarray(0, gz.length - 8), 1024 * 1024);
    assert.equal(truncated.ok, false);
    assert.equal(truncated.reason, "corrupt");
    assert.ok(truncated.detail.length > 0, "should carry the decompressor's message");

    const corrupted = Buffer.from(gz);
    corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
    const damaged = await decodeLayoutBytes(corrupted, 1024 * 1024);
    assert.equal(damaged.ok, false);
    assert.equal(damaged.reason, "corrupt");

    // A gzip header over bytes that aren't deflate data at all.
    const bogus = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(64, 0x5a)]);
    assert.equal((await decodeLayoutBytes(bogus, 1024 * 1024)).reason, "corrupt");
});

test("reads the trailer's stored size, and declines to invent one", () => {
    assert.equal(gzipStoredSize(zlib.gzipSync(fakeLayout(3210))), 3210);
    // Too short to hold a header plus a trailer.
    assert.equal(gzipStoredSize(Uint8Array.from([0x1f, 0x8b, 0x08])), null);
    assert.equal(gzipStoredSize(null), null);
});

test("reads a stored size above 2 GB as a positive number", () => {
    // ISIZE is a little-endian uint32, so the top byte must not be sign-extended
    // -- the sizes this matters for are exactly the ones near the cap.
    const trailer = Buffer.alloc(18);
    trailer.set([0x1f, 0x8b], 0);
    trailer.writeUInt32LE(0xf0000000, 14);
    assert.equal(gzipStoredSize(trailer), 0xf0000000);
});

test("decompresses without a cap when one isn't given", async () => {
    const plain = fakeLayout();
    for (const cap of [undefined, Infinity]) {
        const result = await decodeLayoutBytes(zlib.gzipSync(plain), cap);
        assert.equal(result.ok, true, `cap ${cap}`);
        assert.deepEqual(Buffer.from(result.bytes), plain);
    }
});
