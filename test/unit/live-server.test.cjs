// The live preview server (src/live-server.cjs), driven through the bundled
// extension over real sockets on 127.0.0.1. The client below sends what a
// Python show() call sends and checks the reply the way that client reads it.
//
// Needs dist/extension.js (`npm run compile`; `npm test` runs it first). The
// desktop tests share one activated extension, one server and the editors it
// opened, so they run in order. Ports are ephemeral, never 8082.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const {
    REPO, Uri, fakePanel,
    createVscodeStub, installVscodeStub, loadExtension, extensionContext, until,
} = require('./vscode-stub.cjs');

const { vscode, state } = createVscodeStub({
    config: { 'liveServer.enabled': true, 'liveServer.port': 0, autoReload: false },
});
const hooks = installVscodeStub(vscode);

// ---- the client ------------------------------------------------------------

// What the Python client checks the reply against. It warns that the server
// is out of date when `version` is newer than 0.4.1, and compares
// `klayout_version` with its own layout library version, which it reads
// unguarded: a missing or unparseable one raises in the user's script.
const RECOMMENDED_SERVER_VERSION = '0.4.1';
const CLIENT_LIBRARY_VERSION = '0.30.12';
// It reads the reply with a single 1024-byte read.
const REPLY_READ_BYTES = 1024;

function parseVersion(s) {
    const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(s);
    if (!m) throw new Error('not a semantic version: ' + JSON.stringify(s));
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function compareVersions(a, b) {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
}

// One show() call: connect (0.5 s limit), send the request as one JSON object
// and a newline, read the reply (5 s limit). Resolves to
//   { connected: false }                       nothing listening
//   { connected: true, raw, reply: null }      a plain-text reply
//   { connected: true, raw, reply, warnings }  a JSON reply
// where `warnings` lists what the Python client would warn about. Rejects
// where that client would raise, or when the reply is longer than its one
// read and so would arrive cut off.
function showClient(port, request) {
    return new Promise((resolve, reject) => {
        const sock = net.connect({ port, host: '127.0.0.1' });
        const chunks = [];
        let connected = false;
        let timedOut = false;
        const connectTimer = setTimeout(() => sock.destroy(new Error('connect timeout')), 500);
        sock.on('connect', () => {
            connected = true;
            clearTimeout(connectTimer);
            sock.setTimeout(5000, () => { timedOut = true; sock.destroy(); });
            sock.write(JSON.stringify(request) + '\n');
        });
        sock.on('data', (d) => chunks.push(d));
        sock.on('error', (err) => {
            clearTimeout(connectTimer);
            if (!connected) resolve({ connected: false });
            else reject(err);
        });
        sock.on('close', () => {
            if (!connected) return;  // settled by 'error'
            if (timedOut) return reject(new Error('no reply within 5 s'));
            const all = Buffer.concat(chunks);
            if (all.length > REPLY_READ_BYTES) {
                return reject(new Error(`reply is ${all.length} bytes, past the client's ${REPLY_READ_BYTES}-byte read`));
            }
            const raw = all.toString('utf8');
            let reply;
            try {
                reply = JSON.parse(raw);
            } catch {
                return resolve({ connected: true, raw, reply: null });
            }
            try {
                assert.ok(reply && typeof reply === 'object', 'reply is a JSON object');
                const warnings = [];
                if (reply.type !== 'open' && reply.type !== 'reload') warnings.push('unknown type ' + reply.type);
                if (compareVersions(parseVersion(reply.version), parseVersion(RECOMMENDED_SERVER_VERSION)) > 0) {
                    warnings.push('server version is newer than ' + RECOMMENDED_SERVER_VERSION);
                } else {
                    assert.ok('klayout_version' in reply, 'reply has klayout_version');
                    if (compareVersions(parseVersion(CLIENT_LIBRARY_VERSION), parseVersion(reply.klayout_version)) < 0) {
                        warnings.push('klayout_version is newer than the client library');
                    }
                }
                resolve({ connected: true, raw, reply, warnings });
            } catch (err) {
                reject(new Error('the Python client would raise on this reply: ' + err.message + '\n' + raw));
            }
        });
    });
}

// Raw socket: writes `chunks` one per event-loop turn, optionally half-closes,
// and resolves to whatever came back before the server closed.
function rawExchange(port, chunks, { end = false } = {}) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1');
        let reply = '';
        sock.setEncoding('utf8');
        sock.on('data', (d) => { reply += d; });
        sock.on('close', () => resolve(reply));
        sock.on('error', reject);
        sock.on('connect', async () => {
            for (const c of chunks) {
                sock.write(c);
                await new Promise((r) => setTimeout(r, 20));
            }
            if (end) sock.end();
        });
    });
}

async function freePort() {
    const s = net.createServer();
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const p = s.address().port;
    await new Promise((r) => s.close(r));
    return p;
}

// Waits until nothing accepts connections on `port`.
const portClosed = (port) => until(async () => !(await showClient(port, { gds: '/x.oas' })).connected,
    { what: `port ${port} to close` });

// ---- the fake webview side --------------------------------------------------

// vscode.openWith as the live server triggers it: resolve the custom editor
// into a fake panel, then have the page say 'ready' on the next turn, or hold
// that until the test calls the function left in `heldReady`.
const panels = [];
let holdReady = false;
let heldReady = null;
state.onOpenWith = async (uri, viewType) => {
    assert.strictEqual(viewType, 'GDS-Lens.editor');
    const doc = await state.customEditorProvider.openCustomDocument(uri);
    const panel = fakePanel();
    panels.push(panel);
    await state.customEditorProvider.resolveCustomEditor(doc, panel);
    const ready = () => panel.fromWebview({ command: 'ready' });
    if (holdReady) heldReady = ready;
    else setImmediate(ready);
};

function setConfig(changes) {
    Object.assign(state.config, changes);
    state.configListeners.forEach((f) => f({ affectsConfiguration: (s) => s === 'GDS-Lens.liveServer' }));
}

const bytesOf = (m) => Buffer.from(m.fileData).toString();
const radioTower = (status, port) => status.visible && status.text === `$(radio-tower) ${port}`;

// ---- tests ------------------------------------------------------------------

test('web host: activation survives require("net") throwing', () => {
    hooks.blockNet(true);
    try {
        const ctx = extensionContext();
        loadExtension().activate(ctx);
        assert.strictEqual(state.statusItems.length, 0, 'no status item on the web');
        assert.ok(state.log.some((l) => /not available in this extension host/.test(l)));
        assert.ok(!state.commands['GDS-Lens.liveServer.statusClicked']);
        ctx.subscriptions.forEach((d) => d.dispose && d.dispose());
    } finally {
        hooks.blockNet(false);
    }
});

test('desktop host: live server', async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-lens-live-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const gds = path.join(tmp, 'demo.oas');
    const lyrdb = path.join(tmp, 'demo.lyrdb');
    const port = await freePort();
    state.config['liveServer.port'] = port;

    const ctx = extensionContext();
    loadExtension().activate(ctx);
    let disposed = false;
    t.after(() => { if (!disposed) ctx.subscriptions.forEach((d) => d.dispose && d.dispose()); });
    const status = state.statusItems[0];
    await until(() => radioTower(status, port), { what: 'the server to listen' });

    await t.test('open: new editor beside, file deleted right after the reply', async () => {
        fs.writeFileSync(gds, 'OASIS-BYTES-v1');
        const out = await showClient(port, { gds, keep_position: true, libraries: [] });
        // show() deletes a temporary layout as soon as it has the reply.
        fs.unlinkSync(gds);
        assert.ok(out.reply, out.raw);
        assert.deepStrictEqual(Object.keys(out.reply).sort(), ['file', 'klayout_version', 'type', 'version']);
        assert.strictEqual(out.reply.type, 'open');
        assert.strictEqual(out.reply.version, '0.4.1');
        assert.strictEqual(out.reply.file, gds);
        assert.deepStrictEqual(out.warnings, []);
        const open = state.executed.find((c) => c[0] === 'vscode.openWith');
        assert.ok(open, 'openWith called');
        assert.strictEqual(open[1].toString(), Uri.file(gds).toString());
        assert.strictEqual(open[2], 'GDS-Lens.editor');
        assert.deepStrictEqual(open[3], { viewColumn: -2, preserveFocus: true });
        await until(() => panels[0] && panels[0].posted.some((m) => m.type === 'init'), { what: 'init' });
        const init = panels[0].posted.find((m) => m.type === 'init');
        assert.strictEqual(init.reload, false);
        assert.strictEqual(bytesOf(init), 'OASIS-BYTES-v1');
    });

    await t.test('reload: existing editor, keep_position true, with lyrdb and ignored keys', async () => {
        fs.writeFileSync(gds, 'OASIS-BYTES-v2');
        fs.writeFileSync(lyrdb, '<report-database></report-database>');
        const before = panels[0].posted.length;
        const n = state.executed.length;
        const out = await showClient(port, {
            gds, keep_position: true, lyrdb, libraries: [{ name: 'lib', file: '/x/lib.oas' }],
            technology: 'generic', l2n: '/x/a.l2n',
        });
        fs.unlinkSync(gds);
        fs.unlinkSync(lyrdb);
        assert.strictEqual(out.reply.type, 'reload');
        assert.strictEqual(out.reply.file, gds);
        assert.strictEqual(out.reply.info, 'GDS Lens ignores libraries, l2n, technology');
        assert.deepStrictEqual(out.warnings, []);
        assert.strictEqual(state.executed.length, n, 'no second openWith');
        assert.strictEqual(panels.length, 1);
        const fresh = panels[0].posted.slice(before);
        const init = fresh.find((m) => m.type === 'init');
        assert.strictEqual(init.reload, true);
        assert.strictEqual(bytesOf(init), 'OASIS-BYTES-v2');
        const markers = fresh.find((m) => m.type === 'markersLoaded');
        assert.ok(markers && markers.name === 'demo.lyrdb' && markers.text.includes('report-database'));
        assert.deepStrictEqual(panels[0].revealed.at(-1), [undefined, true]);
        const map = ctx.workspaceState.get('GDS-Lens.markerPathByGds');
        assert.strictEqual(map[Uri.file(gds).toString()], Uri.file(lyrdb).toString());
    });

    await t.test('reload with keep_position false reframes (init reload:false)', async () => {
        fs.writeFileSync(gds, 'OASIS-BYTES-v3');
        const before = panels[0].posted.length;
        const out = await showClient(port, { gds, keep_position: false, libraries: [] });
        assert.strictEqual(out.reply.type, 'reload');
        const init = panels[0].posted.slice(before).find((m) => m.type === 'init');
        assert.strictEqual(init.reload, false);
    });

    await t.test('missing lyrdb is reported in info, layout still reloads', async () => {
        const out = await showClient(port, { gds, keep_position: true, libraries: [], lyrdb: tmp + '/nope.lyrdb' });
        assert.strictEqual(out.reply.type, 'reload');
        assert.match(out.reply.info, /could not read lyrdb/);
    });

    await t.test('missing file: plain-text reply, nothing opened', async () => {
        const n = state.executed.length;
        const out = await showClient(port, { gds: tmp + '/missing.oas', keep_position: true, libraries: [] });
        assert.strictEqual(out.reply, null);
        assert.ok(out.raw.startsWith('GDS Lens: could not open'), out.raw);
        assert.strictEqual(state.executed.length, n);
    });

    await t.test('partial reads: request split across chunks', async () => {
        const msg = JSON.stringify({ gds, keep_position: true, libraries: [] }) + '\n';
        const reply = await rawExchange(port, [msg.slice(0, 5), msg.slice(5, 20), msg.slice(20)]);
        assert.strictEqual(JSON.parse(reply).type, 'reload');
    });

    await t.test('multibyte path split mid-character', async () => {
        const uni = path.join(tmp, 'Ä_µm_é.oas');
        fs.writeFileSync(uni, 'x');
        const bytes = Buffer.from(JSON.stringify({ gds: uni, keep_position: true, libraries: [] }) + '\n');
        const cut = bytes.indexOf(Buffer.from('Ä')) + 1;
        const reply = await rawExchange(port, [bytes.subarray(0, cut), bytes.subarray(cut)]);
        assert.strictEqual(JSON.parse(reply).file, uni);
    });

    await t.test('garbled input gets a plain-text reply', async () => {
        assert.strictEqual(await rawExchange(port, ['this is not json\n']), 'GDS Lens: the request is not valid JSON.');
        assert.strictEqual(await rawExchange(port, ['{"foo": 1}\n']), 'GDS Lens: the request has no "gds" path.');
        assert.strictEqual(await rawExchange(port, ['{"gds": "relative/x.oas"}\n']), 'GDS Lens: "relative/x.oas" is not an absolute path.');
        assert.strictEqual(await rawExchange(port, ['null\n']), 'GDS Lens: the request has no "gds" path.');
    });

    await t.test('no newline then close: no crash, server still serves', async () => {
        await rawExchange(port, ['{"gds": "/x'], { end: true });
        const out = await showClient(port, { gds, keep_position: true, libraries: [] });
        assert.strictEqual(out.reply.type, 'reload');
    });

    await t.test('concurrent show() calls for a new file open it once', async () => {
        const other = path.join(tmp, 'other.oas');
        fs.writeFileSync(other, 'y');
        const n = panels.length;
        const [a, b] = await Promise.all([
            showClient(port, { gds: other, keep_position: true, libraries: [] }),
            showClient(port, { gds: other, keep_position: true, libraries: [] }),
        ]);
        assert.deepStrictEqual([a.reply.type, b.reply.type].sort(), ['open', 'reload']);
        assert.strictEqual(panels.length, n + 1);
    });

    await t.test('show() again before the new webview is ready: first send uses the newest bytes', async () => {
        const slow = path.join(tmp, 'slow.oas');
        fs.writeFileSync(slow, 'first');
        holdReady = true;
        let a, b;
        try {
            a = await showClient(port, { gds: slow, keep_position: true, libraries: [] });
            fs.writeFileSync(slow, 'second');
            b = await showClient(port, { gds: slow, keep_position: true, libraries: [] });
        } finally {
            holdReady = false;
        }
        assert.strictEqual(a.reply.type, 'open');
        assert.strictEqual(b.reply.type, 'reload');
        const panel = panels.at(-1);
        assert.strictEqual(panel.posted.filter((m) => m.type === 'init').length, 0, 'nothing sent before ready');
        assert.ok(heldReady, 'the editor is waiting for ready');
        heldReady();
        // The first send ends with the saved views; nothing is queued after it.
        await until(() => panel.posted.some((m) => m.type === 'namedViews'), { what: 'the first send' });
        fs.unlinkSync(slow);
        const inits = panel.posted.filter((m) => m.type === 'init');
        assert.strictEqual(inits.length, 1);
        assert.strictEqual(bytesOf(inits[0]), 'second');
        assert.strictEqual(inits[0].reload, false);
    });

    await t.test('EADDRINUSE: busy status, log line, no dialog; focus retries', async () => {
        const blocker = net.createServer();
        const busyPort = await freePort();
        await new Promise((r) => blocker.listen(busyPort, '127.0.0.1', r));
        const inUse = () => state.log.filter((l) => l.includes(`port ${busyPort} is in use`)).length;
        setConfig({ 'liveServer.port': busyPort });
        await until(() => status.text === `$(debug-disconnect) ${busyPort}`, { what: 'the busy status' });
        assert.ok(status.visible);
        assert.strictEqual(inUse(), 1);
        assert.deepStrictEqual(state.errors, [], 'no dialogs');
        // Window focus while still busy: tries again, still busy, no crash.
        state.windowStateListeners.forEach((f) => f({ focused: true }));
        await until(() => inUse() === 2, { what: 'the retry on focus' });
        assert.strictEqual(status.text, `$(debug-disconnect) ${busyPort}`);
        await new Promise((r) => blocker.close(r));
        state.windowStateListeners.forEach((f) => f({ focused: true }));
        await until(() => radioTower(status, busyPort), { what: 'the server to take the freed port' });
        const out = await showClient(busyPort, { gds, keep_position: true, libraries: [] });
        assert.strictEqual(out.reply.type, 'reload');
    });

    await t.test('settings: disable hides status and closes the port; re-enable rebinds', async () => {
        const p = state.config['liveServer.port'];
        setConfig({ 'liveServer.enabled': false });
        assert.strictEqual(status.visible, false);
        await portClosed(p);
        setConfig({ 'liveServer.enabled': true, 'liveServer.port': port });
        await until(() => radioTower(status, port), { what: 'the server to listen again' });
        const out = await showClient(port, { gds, keep_position: true, libraries: [] });
        assert.strictEqual(out.reply.type, 'reload');
    });

    await t.test('status click shows the log', async () => {
        await state.commands['GDS-Lens.liveServer.statusClicked']();
        assert.ok(state.logShown);
    });

    await t.test('dispose stops the server', async () => {
        ctx.subscriptions.forEach((d) => d.dispose && d.dispose());
        disposed = true;
        await portClosed(port);
    });
});

// ---- the source module, no server ------------------------------------------

test('WSL path mapping', () => {
    const { uriFromKlivePath } = require(REPO + '/src/live-server.cjs');
    const p = (s, r) => { const u = uriFromKlivePath(s, r); return u && u.toString(); };
    assert.strictEqual(p('\\\\wsl.localhost\\Ubuntu\\home\\me\\build\\a.oas', 'wsl'), 'file:///home/me/build/a.oas');
    assert.strictEqual(p('\\\\wsl$\\Ubuntu-22.04\\tmp\\a b.oas', 'wsl'), 'file:///tmp/a%20b.oas');
    assert.strictEqual(p('C:\\Users\\me\\a.oas', 'wsl'), 'file:///mnt/c/Users/me/a.oas');
    assert.strictEqual(p('/home/me/a.oas', 'wsl'), 'file:///home/me/a.oas');
    assert.strictEqual(p('/home/me/a.oas', undefined), 'file:///home/me/a.oas');
    // Not in WSL: a UNC path stays a UNC path.
    assert.strictEqual(p('\\\\wsl.localhost\\Ubuntu\\home\\a.oas', undefined), 'file://wsl.localhost/Ubuntu/home/a.oas');
    assert.strictEqual(p('relative.oas', undefined), null);
    assert.strictEqual(p('', undefined), null);
    assert.strictEqual(p(42, undefined), null);
});

test('reply stays within 1024 bytes (info dropped when too long), versions parse', () => {
    const { buildReply, KLIVE_VERSION, KLAYOUT_VERSION } = require(REPO + '/src/live-server.cjs');
    const r = buildReply('open', '/' + 'a'.repeat(800), 'x'.repeat(400));
    assert.ok(Buffer.byteLength(r) <= REPLY_READ_BYTES);
    assert.ok(!('info' in JSON.parse(r)));
    const short = JSON.parse(buildReply('reload', '/a.oas', 'note'));
    assert.strictEqual(short.info, 'note');
    assert.ok(compareVersions(parseVersion(KLIVE_VERSION), parseVersion(RECOMMENDED_SERVER_VERSION)) <= 0);
    assert.ok(compareVersions(parseVersion(KLAYOUT_VERSION), parseVersion(CLIENT_LIBRARY_VERSION)) <= 0);
});
