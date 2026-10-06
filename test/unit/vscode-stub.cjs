// Shared scaffolding for the unit tests: a stand-in for the `vscode` module,
// fake webview panels, and a loader for the bundled extension. Not a test file
// itself (no .test.cjs suffix), so `node --test` does not run it.
//
// The stub covers what src/ calls during activation, editor and comparison
// opens, and the live preview server, and nothing more. A test that reaches a
// part of the API missing here fails with a TypeError naming it, which is the
// cue to add it.
const Module = require('module');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(REPO, 'test', 'fixtures');
const BUNDLE = path.join(REPO, 'dist', 'extension.js');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));

class Uri {
    constructor(scheme, authority, uriPath) {
        this.scheme = scheme;
        this.authority = authority || '';
        this.path = uriPath;
    }
    // Close enough to VS Code's for the paths these tests use: backslashes
    // become slashes, a UNC host becomes the authority, a drive letter gets a
    // leading slash.
    static file(p) {
        let authority = '';
        let uriPath = p.replace(/\\/g, '/');
        if (uriPath.startsWith('//')) {
            const rest = uriPath.slice(2);
            const i = rest.indexOf('/');
            authority = i < 0 ? rest : rest.slice(0, i);
            uriPath = i < 0 ? '/' : rest.slice(i);
        } else if (/^[a-zA-Z]:/.test(uriPath)) {
            uriPath = '/' + uriPath;
        }
        return new Uri('file', authority, uriPath);
    }
    static parse(s) {
        const m = /^([a-z]+):\/\/([^/]*)(.*)$/.exec(s);
        return new Uri(m[1], m[2], decodeURI(m[3]));
    }
    static joinPath(u, ...parts) {
        return new Uri(u.scheme, u.authority, path.posix.join(u.path, ...parts));
    }
    get fsPath() { return this.path; }
    toString() { return this.scheme + '://' + this.authority + encodeURI(this.path); }
}

class EventEmitter {
    constructor() {
        this.listeners = [];
        this.event = (f) => {
            this.listeners.push(f);
            return { dispose: () => { this.listeners = this.listeners.filter((x) => x !== f); } };
        };
    }
    fire(v) { [...this.listeners].forEach((f) => f(v)); }
}

// globalState / workspaceState.
function memento() {
    const m = new Map();
    return { get: (k) => m.get(k), update: async (k, v) => { m.set(k, v); } };
}

// A webview panel as resolveCustomEditor and createWebviewPanel hand one out.
// `fromWebview(m)` delivers a message as if the page had posted it.
function fakePanel() {
    const recv = new EventEmitter();
    const disposeEv = new EventEmitter();
    const panel = {
        active: false,
        posted: [],
        revealed: [],
        reveal(col, preserve) { this.revealed.push([col, preserve]); },
        onDidDispose: (f) => disposeEv.event(f),
        dispose() { disposeEv.fire(); },
        webview: {
            options: {},
            html: '',
            cspSource: 'vscode-resource:',
            asWebviewUri: (u) => u,
            postMessage(m) { panel.posted.push(m); return Promise.resolve(true); },
            onDidReceiveMessage: (f) => recv.event(f),
        },
        fromWebview: (m) => recv.fire(m),
        // How many message listeners the host has registered so far.
        listenerCount: () => recv.listeners.length,
        actions() { return this.posted.filter((m) => m.type === 'viewerAction').map((m) => m.action); },
    };
    return panel;
}

// Builds a `vscode` stub. Everything a test wants to look at afterwards is on
// the returned `state`; `config` is read by getConfiguration().get().
function createVscodeStub({ config = {} } = {}) {
    const state = {
        log: [],
        logShown: false,
        messages: [],          // showInformationMessage and showErrorMessage
        errors: [],            // showErrorMessage only
        executed: [],          // executeCommand calls, as argument arrays
        statusItems: [],
        commands: {},
        createdPanels: [],
        customEditorProvider: null,
        configListeners: [],
        windowStateListeners: [],
        remoteName: undefined,
        config,
        // Set to a function to act on vscode.openWith (the live server uses it).
        onOpenWith: null,
    };
    const vscode = {
        Uri,
        EventEmitter,
        ViewColumn: { Beside: -2, Active: -1 },
        StatusBarAlignment: { Left: 1, Right: 2 },
        ConfigurationTarget: { Global: 1 },
        InputBoxValidationSeverity: { Warning: 2 },
        RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
        env: { get remoteName() { return state.remoteName; } },
        window: {
            createOutputChannel: () => ({
                appendLine: (l) => state.log.push(l),
                show: () => { state.logShown = true; },
            }),
            createStatusBarItem: () => {
                const item = {
                    text: '', tooltip: '', visible: false,
                    show() { this.visible = true; },
                    hide() { this.visible = false; },
                    dispose() { this.disposed = true; },
                };
                state.statusItems.push(item);
                return item;
            },
            registerCustomEditorProvider: (_id, provider) => {
                state.customEditorProvider = provider;
                return { dispose() {} };
            },
            createWebviewPanel: () => {
                const p = fakePanel();
                state.createdPanels.push(p);
                return p;
            },
            showErrorMessage: (m) => { state.messages.push(m); state.errors.push(m); },
            showInformationMessage: (m) => { state.messages.push(m); },
            setStatusBarMessage: () => {},
            showOpenDialog: async () => undefined,
            showInputBox: async () => '1, 2',
            onDidChangeWindowState: (f) => {
                state.windowStateListeners.push(f);
                return { dispose() {} };
            },
        },
        commands: {
            registerCommand: (id, f) => {
                state.commands[id] = f;
                return { dispose() { delete state.commands[id]; } };
            },
            executeCommand: async (...args) => {
                state.executed.push(args);
                if (args[0] === 'vscode.openWith' && state.onOpenWith) await state.onOpenWith(...args.slice(1));
            },
        },
        workspace: {
            getConfiguration: () => ({
                get: (k, d) => (k in state.config ? state.config[k] : d),
                update: async () => {},
            }),
            onDidChangeConfiguration: (f) => {
                state.configListeners.push(f);
                return { dispose() {} };
            },
            fs: {
                stat: async (u) => {
                    const s = fs.statSync(u.fsPath);
                    return { size: s.size, mtime: s.mtimeMs };
                },
                readFile: async (u) => new Uint8Array(fs.readFileSync(u.fsPath)),
            },
            createFileSystemWatcher: () => ({
                onDidChange: () => ({ dispose() {} }),
                onDidCreate: () => ({ dispose() {} }),
                dispose() {},
            }),
        },
    };
    return { vscode, state };
}

// Routes require('vscode') to `vscode` for the rest of this process. Each test
// file runs in its own process under `node --test`, so this never leaks
// between files. `blockNet()` makes require('net') throw, the way it does in
// the Web Worker extension host.
function installVscodeStub(vscode) {
    const hooks = { netThrows: false };
    const origLoad = Module._load;
    Module._load = function (request, ...rest) {
        if (request === 'vscode') return vscode;
        if (request === 'net' && hooks.netThrows) throw new Error("Cannot load module 'net'");
        return origLoad.call(this, request, ...rest);
    };
    return {
        blockNet(on = true) { hooks.netThrows = on; },
        restore() { Module._load = origLoad; },
    };
}

// A fresh copy of the bundled extension (dist/extension.js). The bundle has
// its own copy of shared.cjs and live-server.cjs inlined, so each load starts
// from clean module state. Needs `npm run compile` first; `npm test` does that.
function loadExtension() {
    if (!fs.existsSync(BUNDLE)) {
        throw new Error(BUNDLE + ' is missing: run `npm run compile` before these tests.');
    }
    delete require.cache[require.resolve(BUNDLE)];
    return require(BUNDLE);
}

// An ExtensionContext for activate().
function extensionContext() {
    return {
        subscriptions: [],
        extensionUri: Uri.file(REPO),
        globalState: memento(),
        workspaceState: memento(),
        extension: { id: 'ethml.GDS-Lens', packageJSON: pkg },
    };
}

// Runs src/webview-host.js as the webview would, against a stubbed window.
// `send(data)` delivers a message from the extension host; `out` collects
// what the page posts back.
const hostSrc = fs.readFileSync(path.join(REPO, 'src', 'webview-host.js'), 'utf8');
function loadWebviewHost(userAgent = '') {
    const listeners = [];
    const out = [];
    const win = { addEventListener: (_t, f) => listeners.push(f) };
    const run = new Function('window', 'document', 'navigator', 'acquireVsCodeApi', hostSrc);
    run(win, {}, { userAgent }, () => ({ postMessage: (m) => out.push(m) }));
    return { host: win.gdsLensHost, out, send: (data) => listeners.forEach((f) => f({ data })) };
}

// Polls `check` (sync or async) until it returns truthy. For state that
// changes without an event the test can subscribe to. Bounded: throws after
// `ms` with `what` in the message.
async function until(check, { ms = 5000, what = 'condition' } = {}) {
    const end = Date.now() + ms;
    for (;;) {
        if (await check()) return;
        if (Date.now() > end) throw new Error('timed out after ' + ms + 'ms waiting for ' + what);
        await new Promise((r) => setTimeout(r, 10));
    }
}

module.exports = {
    REPO,
    FIXTURES,
    pkg,
    Uri,
    EventEmitter,
    memento,
    fakePanel,
    createVscodeStub,
    installVscodeStub,
    loadExtension,
    extensionContext,
    loadWebviewHost,
    until,
};
