// Turns the bytes read off disk into the bytes the viewer parses: a gzipped
// layout (`.gds.gz` and friends) is expanded here, and everything downstream --
// the webview, the parse Worker, the wasm module's own GDSII/OASIS sniffing --
// sees exactly what an uncompressed file would have produced.
//
// Expanding in the extension host rather than in the webview or the wasm module
// is a memory decision. The viewer's entire size budget is the 32-bit wasm heap:
// the file's bytes and the flattened geometry built from them both have to fit
// in 4 GB (see DEVELOPING.md), and that heap is the one address space that can
// least afford a second full copy of the file. The host has no such ceiling, so
// doing it here spends the compressed copy and the decompressor's scratch space
// where they cost nothing, and hands the wasm side a single buffer.
//
// Built on the platform's DecompressionStream rather than Node's zlib, so the
// same code runs in the desktop extension host and in the Web Worker extension
// host vscode.dev uses (see "Running on the web" in DEVELOPING.md). That makes
// expansion async, which is the one shape change from the zlib version; it also
// makes the size cap ours to enforce, since there is no `maxOutputLength` to
// hand off to -- that's what the running total in gunzip() is for.
//
// Standalone, no imports, with a module.exports tail -- the same shape as
// marker-parsers.js and load-errors.js, so the tests can require() it directly.
"use strict";

// gzip's magic number: RFC 1952's ID1/ID2. Detection is by content rather than
// by a ".gz" on the name, matching how GDSII vs OASIS is already decided (see
// detect_format in gds_common.hpp). That way a layout named with an unexpected
// extension still loads, and so does a plain ".gds" that is secretly gzipped --
// which is how these arrive out of some flows.
const GZIP_ID1 = 0x1f;
const GZIP_ID2 = 0x8b;

// Smallest possible gzip member: a 10-byte header plus an 8-byte trailer.
const GZIP_MIN_BYTES = 18;

function looksGzipped(bytes) {
    return !!bytes && bytes.length >= 2 && bytes[0] === GZIP_ID1 && bytes[1] === GZIP_ID2;
}

// The uncompressed size gzip records in its trailer (RFC 1952's ISIZE), or null
// if the input is too short to hold one.
//
// Only ever used to word a message. It's stored modulo 2^32, and for a
// multi-member file it describes the last member alone, so it is a hint about
// the file rather than a fact about it -- which is exactly why it isn't what
// enforces the limit below. The running total in gunzip() does that, by stopping
// the moment the output overruns instead of trusting what the file claims about
// itself.
//
// Read by hand rather than with Buffer.readUInt32LE: the caller's bytes come
// from vscode.workspace.fs.readFile, which yields a plain Uint8Array. The top
// byte is multiplied rather than shifted, since `<< 24` would make sizes over
// 2 GB come back negative.
function gzipStoredSize(bytes) {
    if (!bytes || bytes.length < GZIP_MIN_BYTES) return null;
    const end = bytes.length;
    return bytes[end - 4] + bytes[end - 3] * 0x100 + bytes[end - 2] * 0x10000 +
           bytes[end - 1] * 0x1000000;
}

// Expands one gzip buffer, refusing to accumulate more than `cap` bytes.
//
// The write side is started but deliberately not awaited before reading. A
// DecompressionStream applies backpressure, so `writer.write()` of a whole
// layout doesn't settle until the read loop below has drained it -- awaiting it
// first would deadlock. Its rejection is swallowed because every failure the
// stream can have (a bad header, a truncated body, corrupt deflate data) also
// surfaces from `reader.read()`, which is where the throw wants to come from;
// without the catch, the same error would additionally go unhandled here.
async function gunzip(bytes, cap) {
    const stream = new DecompressionStream("gzip");
    const writer = stream.writable.getWriter();
    const pump = writer.write(bytes).then(() => writer.close()).catch(() => {});

    const reader = stream.readable.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        // `>` rather than `>=`: a file expanding to exactly the cap still fits.
        if (total > cap) {
            await reader.cancel();
            await pump;
            const err = new Error(`expands past the ${cap} byte limit`);
            err.tooLarge = true;
            throw err;
        }
        chunks.push(value);
    }
    await pump;

    // A layout that arrived in one chunk is handed straight back rather than
    // copied into a second buffer of the same size. At these sizes the copy is
    // the expensive part, not the bookkeeping.
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.byteLength;
    }
    return out;
}

// Uncompressed layout bytes, whatever the input was.
//
//   { ok: true,  bytes, gzipped, storedSize }
//   { ok: false, reason: "too-large" | "corrupt", storedSize, detail }
//
// Not-gzipped input is passed straight back, untouched and uncopied, so the
// ordinary path costs one two-byte comparison. maxBytes caps what a compressed
// file is allowed to expand to; pass a non-finite value for no cap. The reason
// codes are split because the two failures need different things said about
// them -- one is about this machine's limits, the other about the file being
// broken or half-written -- and the prose for both lives with the caller's other
// messages rather than here.
async function decodeLayoutBytes(bytes, maxBytes) {
    if (!looksGzipped(bytes)) return { ok: true, bytes: bytes, gzipped: false, storedSize: null };

    const storedSize = gzipStoredSize(bytes);
    try {
        const cap = Number.isFinite(maxBytes) ? maxBytes : Infinity;
        return { ok: true, bytes: await gunzip(bytes, cap), gzipped: true, storedSize: storedSize };
    } catch (err) {
        // The `tooLarge` flag is the cap above being hit -- the one failure here
        // that's about size rather than about the data. Everything else is the
        // decompressor refusing the stream itself, which means the compressed
        // data can't be read at all.
        return {
            ok: false,
            reason: err && err.tooLarge ? "too-large" : "corrupt",
            storedSize: storedSize,
            detail: err && err.message ? err.message : String(err)
        };
    }
}

module.exports = { looksGzipped, gzipStoredSize, decodeLayoutBytes };
