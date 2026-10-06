// Keyboard shortcuts: the per-platform rows built from package.json, the
// GDS-Lens.viewerKeys context key, which panel an action command goes to, and
// the webview side in src/webview-host.js.
//
// Needs dist/extension.js (`npm run compile`; `npm test` runs it first). The
// tests after "no viewer" share one activated extension and build on the
// panels the earlier ones opened, so they run in order.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
    REPO, FIXTURES, pkg, Uri, fakePanel,
    createVscodeStub, installVscodeStub, loadExtension, extensionContext, loadWebviewHost, until,
} = require('./vscode-stub.cjs');

const { vscode, state } = createVscodeStub({ config: { 'liveServer.enabled': false } });
installVscodeStub(vscode);
const shared = require(REPO + '/src/shared.cjs');

const contextCalls = () => state.executed.filter((c) => c[0] === 'setContext').map((c) => [c[1], c[2]]);
const layouts = fs.readdirSync(FIXTURES).filter((n) => /\.(gds|oas)$/.test(n)).sort().map((n) => path.join(FIXTURES, n));

test('formatKeybinding per platform', () => {
    const f = shared.formatKeybinding;
    assert.strictEqual(f('h', 'mac'), 'H');
    assert.strictEqual(f('/', 'win'), '/');
    assert.strictEqual(f('[', 'linux'), '[');
    assert.strictEqual(f('ctrl+g', 'mac'), '⌃G');
    assert.strictEqual(f('ctrl+g', 'win'), 'Ctrl+G');
    assert.strictEqual(f('cmd+k d', 'mac'), '⌘K D');
    assert.strictEqual(f('ctrl+k d', 'linux'), 'Ctrl+K D');
    assert.strictEqual(f('ctrl+shift+alt+meta+escape', 'win'), 'Ctrl+Shift+Alt+Win+Esc');
    assert.strictEqual(f('shift+cmd+alt+ctrl+up', 'mac'), '⌃⌥⇧⌘↑');
    assert.strictEqual(f('ctrl++', 'linux'), 'Ctrl++');
    assert.strictEqual(f('pagedown', 'linux'), 'PageDown');
    assert.strictEqual(f('f5', 'win'), 'F5');
});

test('buildShortcutRows from package.json, editor and compare', () => {
    const rows = shared.buildShortcutRows(pkg);
    assert.deepStrictEqual(rows.map((r) => [r.label, r.keys.mac, r.keys.win, r.keys.linux]), [
        ['Show or hide the cell hierarchy', 'H', 'H', 'H'],
        ['Find a cell or label', '/', '/', '/'],
        ['Turn measure mode on or off', 'M', 'M', 'M'],
        ['Previous marker', '[', '[', '['],
        ['Next marker', ']', ']', ']'],
        ['Go to a coordinate', '⌃G', 'Ctrl+G', 'Ctrl+G'],
        ['Compare with another layout', '⌘K D', 'Ctrl+K D', 'Ctrl+K D'],
    ]);
    const compareRows = shared.buildShortcutRows(pkg, { compare: true });
    assert.strictEqual(compareRows.length, 6);
    assert.ok(!compareRows.some((r) => /Compare/.test(r.label)));
    assert.deepStrictEqual(shared.buildShortcutRows({}), []);
});

test('package.json: every action command has a binding on the context key, showShortcuts none', () => {
    const kb = pkg.contributes.keybindings;
    for (const [cmd, key] of [['toggleHierarchy', 'h'], ['focusFind', '/'], ['toggleMeasure', 'm'], ['previousMarker', '['], ['nextMarker', ']']]) {
        const b = kb.find((x) => x.command === 'GDS-Lens.' + cmd);
        assert.strictEqual(b.key, key);
        assert.ok(b.when.startsWith('GDS-Lens.viewerKeys && ('), b.when);
    }
    assert.ok(!kb.some((x) => x.command === 'GDS-Lens.showShortcuts'));
    const ids = pkg.contributes.commands.map((c) => c.command);
    for (const id of Object.keys(shared.VIEWER_ACTIONS)) {
        assert.ok(ids.includes(id), id);
        assert.ok(pkg.contributes.menus.commandPalette.some(
            (m) => m.command === id && /activeWebviewPanelId == 'GDS-Lens.compare'/.test(m.when)), id);
    }
});

test('bundled extension: shortcut routing', async (t) => {
    const ext = loadExtension();
    const ctx = extensionContext();
    ext.activate(ctx);
    t.after(() => ctx.subscriptions.forEach((d) => d.dispose && d.dispose()));
    const commands = state.commands;

    // Opens a layout in a fake editor and waits for the host to finish its
    // first send, which ends with the saved views.
    const openEditor = async (file) => {
        const panel = fakePanel();
        const doc = await state.customEditorProvider.openCustomDocument(Uri.file(file));
        await state.customEditorProvider.resolveCustomEditor(doc, panel);
        panel.fromWebview({ command: 'ready' });
        await until(() => panel.posted.some((m) => m.type === 'namedViews'), { what: 'the first send to ' + file });
        return panel;
    };
    assert.ok(layouts.length >= 2, 'needs two layouts in test/fixtures');

    let a, b;

    await t.test('no viewer: action command says to open a layout', async () => {
        await commands['GDS-Lens.toggleMeasure']();
        assert.strictEqual(state.messages.at(-1), 'GDS Lens: open a layout first.');
        await commands['GDS-Lens.showShortcuts']();
        assert.strictEqual(state.messages.at(-1), 'GDS Lens: open a layout first.');
    });

    await t.test('editor sends shortcut rows before the layout', async () => {
        a = await openEditor(layouts[0]);
        const types = a.posted.map((m) => m.type);
        assert.ok(types.indexOf('shortcuts') >= 0 && types.indexOf('shortcuts') < types.indexOf('init'), types.join());
        assert.strictEqual(a.posted.find((m) => m.type === 'shortcuts').rows.length, 7);
    });

    await t.test('single editor, unfocused: commands go to the only panel', async () => {
        await commands['GDS-Lens.toggleHierarchy']();
        assert.deepStrictEqual(a.actions(), ['toggleHierarchy']);
    });

    await t.test('context key set on true, kept across focus handoff, cleared on false', async () => {
        b = await openEditor(layouts[1]);
        state.executed.length = 0;
        a.fromWebview({ command: 'keyboardContext', active: true });
        assert.deepStrictEqual(contextCalls(), [['GDS-Lens.viewerKeys', true]]);
        // B gains focus before A reports losing it: still true, no extra call.
        b.fromWebview({ command: 'keyboardContext', active: true });
        a.fromWebview({ command: 'keyboardContext', active: false });
        assert.deepStrictEqual(contextCalls(), [['GDS-Lens.viewerKeys', true]]);
        await commands['GDS-Lens.nextMarker']();
        assert.deepStrictEqual(b.actions(), ['nextMarker']);
        b.fromWebview({ command: 'keyboardContext', active: false });
        assert.deepStrictEqual(contextCalls().at(-1), ['GDS-Lens.viewerKeys', false]);
    });

    await t.test('two editors, none active or focused: ambiguity is reported', async () => {
        await commands['GDS-Lens.previousMarker']();
        assert.match(state.messages.at(-1), /click the layout you want/);
        b.active = true;
        await commands['GDS-Lens.previousMarker']();
        assert.deepStrictEqual(b.actions(), ['nextMarker', 'previousMarker']);
        b.active = false;
    });

    await t.test('focused panel wins over the active one', async () => {
        a.active = true;
        b.fromWebview({ command: 'keyboardContext', active: true });
        await commands['GDS-Lens.focusFind']();
        assert.deepStrictEqual(b.actions().at(-1), 'focusFind');
        a.active = false;
    });

    await t.test('dispose of the reporting panel clears the context key', async () => {
        state.executed.length = 0;
        b.dispose();
        assert.deepStrictEqual(contextCalls(), [['GDS-Lens.viewerKeys', false]]);
        // A disposed panel's late message changes nothing.
        b.fromWebview({ command: 'keyboardContext', active: true });
        assert.deepStrictEqual(contextCalls(), [['GDS-Lens.viewerKeys', false]]);
    });

    await t.test('compare panel: rows without compareWithCurrent, actions and goToCoordinate routed to it', async () => {
        const before = state.createdPanels.length;
        const opening = commands['GDS-Lens.compareLayouts'](undefined, [Uri.file(layouts[0]), Uri.file(layouts[1])]);
        // The 'ready' only counts once the host is listening for it.
        await until(() => state.createdPanels.length > before && state.createdPanels.at(-1).listenerCount() > 0,
            { what: 'the comparison panel to listen' });
        const cmp = state.createdPanels.at(-1);
        cmp.fromWebview({ command: 'ready' });
        await opening;
        await until(() => cmp.posted.some((m) => m.type === 'shortcuts'), { what: 'shortcut rows in the comparison' });
        assert.strictEqual(cmp.posted.find((m) => m.type === 'shortcuts').rows.length, 6);
        cmp.active = true;
        await commands['GDS-Lens.toggleMeasure']();
        assert.deepStrictEqual(cmp.actions(), ['toggleMeasure']);
        assert.ok(!a.actions().includes('toggleMeasure'));
        await commands['GDS-Lens.goToCoordinate']();
        assert.deepStrictEqual(cmp.posted.at(-1), { type: 'goToPoint', x: 1, y: 2 });
        cmp.fromWebview({ command: 'keyboardContext', active: true });
        cmp.active = false;
        await commands['GDS-Lens.showShortcuts']();
        assert.deepStrictEqual(cmp.actions().at(-1), 'showShortcuts');
        state.executed.length = 0;
        cmp.dispose();
        assert.deepStrictEqual(contextCalls(), [['GDS-Lens.viewerKeys', false]]);
    });

    await t.test('customize opens Keyboard Shortcuts filtered to the extension', async () => {
        state.executed.length = 0;
        a.fromWebview({ command: 'customizeShortcuts' });
        assert.deepStrictEqual(state.executed, [['workbench.action.openGlobalKeybindings', '@ext:ethml.GDS-Lens']]);
    });

    await t.test('goToCoordinate still works for an editor', async () => {
        a.active = true;
        await commands['GDS-Lens.goToCoordinate']();
        assert.deepStrictEqual(a.posted.at(-1), { type: 'goToPoint', x: 1, y: 2 });
    });
});

test('webview: shortcuts() waits for rows, picks the platform, re-send replaces', async () => {
    const rowsMsg = { type: 'shortcuts', rows: shared.buildShortcutRows(pkg) };
    const mac = loadWebviewHost('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    const pending = mac.host.shortcuts();
    assert.ok(pending instanceof Promise);
    mac.send(rowsMsg);  // before connect: must not be queued behind the viewer
    const rows = await pending;
    assert.deepStrictEqual(rows.at(-1), { label: 'Compare with another layout', keys: '⌘K D' });
    assert.deepStrictEqual(rows[0], { action: 'toggleHierarchy', label: 'Show or hide the cell hierarchy', keys: 'H' });
    assert.strictEqual(mac.host.shortcuts(), rows);
    mac.send({ type: 'shortcuts', rows: rowsMsg.rows.slice(0, 1) });
    assert.strictEqual(mac.host.shortcuts().length, 1);

    const win = loadWebviewHost('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    win.send(rowsMsg);
    assert.strictEqual(win.host.shortcuts().at(-2).keys, 'Ctrl+G');
    const linux = loadWebviewHost('Mozilla/5.0 (X11; Linux x86_64)');
    linux.send(rowsMsg);
    assert.strictEqual(linux.host.shortcuts().at(-1).keys, 'Ctrl+K D');

    // Once a viewer is connected, new rows make it re-read them, so its
    // tooltips' key hints follow.
    let refreshed = 0;
    linux.host.connect({ refreshShortcuts: () => { refreshed++; } });
    linux.send(rowsMsg);
    assert.strictEqual(refreshed, 1);
});

test('webview: viewerAction runs, setKeyboardContext and customize post', () => {
    const w = loadWebviewHost('Macintosh');
    const ran = [];
    w.send({ type: 'viewerAction', action: 'toggleMeasure' });  // queued until connect
    w.host.connect({ runAction: (x) => ran.push(x), refreshShortcuts: () => {} });
    w.send({ type: 'viewerAction', action: 'showShortcuts' });
    assert.deepStrictEqual(ran, ['toggleMeasure', 'showShortcuts']);
    w.host.setKeyboardContext(true);
    w.host.setKeyboardContext(0);
    w.host.customizeShortcuts();
    assert.deepStrictEqual(w.out[0], { command: 'ready' });
    assert.deepStrictEqual(w.out.slice(1), [
        { command: 'keyboardContext', active: true },
        { command: 'keyboardContext', active: false },
        { command: 'customizeShortcuts' },
    ]);
});
