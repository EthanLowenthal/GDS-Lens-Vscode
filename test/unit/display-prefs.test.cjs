// Display toggles remembered across layouts: what src/shared.cjs keeps in
// globalState and pushes to a webview, and how src/webview-host.js hands them
// to the viewer and posts changes back. Runs on the sources, no bundle needed.
const test = require('node:test');
const assert = require('node:assert');
const { createVscodeStub, installVscodeStub, memento, loadWebviewHost, REPO } = require('./vscode-stub.cjs');

installVscodeStub(createVscodeStub().vscode);
const shared = require(REPO + '/src/shared.cjs');

test('shared.cjs: nothing saved posts null, saving keeps only known boolean toggles', () => {
    const context = { globalState: memento() };
    const posted = [];
    shared.postDisplayPrefs(context, (m) => posted.push(m));
    assert.deepStrictEqual(posted[0], { type: 'displayPrefs', prefs: null });

    shared.saveDisplayPrefs(context, { showPorts: true, showGrid: false, showText: 'yes', evil: 'x'.repeat(10) });
    assert.deepStrictEqual(context.globalState.get('GDS-Lens.displayPrefs'), { showPorts: true, showGrid: false });

    shared.postDisplayPrefs(context, (m) => posted.push(m));
    assert.deepStrictEqual(posted[1], { type: 'displayPrefs', prefs: { showPorts: true, showGrid: false } });
});

test('webview-host.js: loadDisplay resolves from the first push, saveDisplay posts', async () => {
    const { host, out, send } = loadWebviewHost();
    host.connect({});
    const pending = host.loadDisplay();
    send({ type: 'displayPrefs', prefs: { showGrid: false } });
    // A second push after the first has been taken is dropped.
    send({ type: 'displayPrefs', prefs: { showGrid: true } });
    host.saveDisplay({ showInfill: true });
    assert.deepStrictEqual(await pending, { showGrid: false });
    assert.deepStrictEqual(out.at(-1), { command: 'saveDisplay', prefs: { showInfill: true } });
});
