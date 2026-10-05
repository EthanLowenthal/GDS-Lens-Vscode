// The live preview server: a KLive-compatible listener, so gdsfactory and
// kfactory's show() opens its layout here rather than in KLayout. show()
// connects to 127.0.0.1:8082, sends one JSON object ending in a newline, reads
// one JSON reply and closes. This file speaks that protocol and nothing else;
// what "open this layout" means is the `show` callback extension.cjs passes in.
//
// The one place in the host that uses a Node builtin. `net` is required at
// runtime, inside a try, rather than at the top: the bundle is built for the
// browser platform with `net` marked external, so on the desktop host the
// require finds Node's module, and on the Web Worker host (vscode.dev) it
// throws and the server simply does not exist. See "Live preview server" in
// DEVELOPING.md.
const vscode = require('vscode');
const { logger } = require('./shared.cjs');

const DEFAULT_PORT = 8082;

// What the reply says it is. kfactory compares `version` against the klive
// version it recommends (0.4.1 at the time of writing) with
// `rec_klive_version.compare(klive_version) >= 0`, so it warns that klive is
// out of date for anything *newer* than 0.4.1 -- klive 0.4.3 itself gets the
// warning. 0.4.1 exactly passes that check and the one it presumably means.
const KLIVE_VERSION = '0.4.1';
// kfactory reads `klayout_version` unguarded whenever the version check above
// passes, so leaving it out makes show() raise a KeyError in the user's
// script. It only feeds a GUI-versus-Python KLayout comparison that does not
// apply here. 0.28.13 is the oldest KLayout kfactory recommends: today that
// comparison logs only when the Python KLayout is older than this, and if it
// is ever flipped to check this value against that floor, it still passes.
const KLAYOUT_VERSION = '0.28.13';

// kfactory reads the reply with a single recv(1024), so a longer one arrives
// cut off and fails to parse. The optional `info` is dropped to stay under it.
const MAX_REPLY_BYTES = 1024;

// The request is a few paths and flags. Anything larger, or a connection that
// sends nothing for this long, is not kfactory and is dropped.
const MAX_REQUEST_CHARS = 1024 * 1024;
const IDLE_TIMEOUT_MS = 10000;

function loadNet() {
    try {
        return require('net');
    } catch {
        return null;
    }
}

// Turns the path kfactory sent into a URI. Under WSL kfactory runs every path
// through `wslpath -w`, so a file in the Linux filesystem arrives as
// \\wsl.localhost\<distro>\home\... (or \\wsl$\<distro>\... on older builds)
// and one under /mnt/c as C:\.... When this extension host is itself inside
// WSL (a Remote - WSL window), those are mapped back to the POSIX paths it can
// read. Anywhere else the path is used as it came: a Windows host reads the
// UNC form directly. Null for anything that is not an absolute path.
function uriFromKlivePath(path, remoteName = vscode.env.remoteName) {
    if (typeof path !== 'string' || !path) return null;
    if (remoteName === 'wsl') {
        const unc = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+(\\.*)?$/i.exec(path);
        if (unc) return vscode.Uri.file((unc[1] || '\\').replace(/\\/g, '/'));
        const drive = /^([a-zA-Z]):[\\/](.*)$/.exec(path);
        if (drive) {
            return vscode.Uri.file('/mnt/' + drive[1].toLowerCase() + '/' + drive[2].replace(/\\/g, '/'));
        }
    }
    if (!/^(\/|[a-zA-Z]:[\\/]|\\\\)/.test(path)) return null;
    return vscode.Uri.file(path);
}

// The reply klive sends, minus `info` if that would push it past what
// kfactory reads.
function buildReply(type, file, info) {
    const reply = { version: KLIVE_VERSION, klayout_version: KLAYOUT_VERSION, type, file };
    if (info) {
        const withInfo = JSON.stringify({ ...reply, info });
        if (new TextEncoder().encode(withInfo).length <= MAX_REPLY_BYTES) return withInfo;
    }
    return JSON.stringify(reply);
}

// Checks one request and hands it to `show`. Resolves to the text to reply
// with. A request that cannot be served gets a plain-text reply rather than
// JSON: klive itself sends nothing on an error and leaves kfactory to time out
// after 5 seconds, but kfactory logs any reply that is not JSON as
// "Message from klive: ..." and carries on, so a sentence saying what went
// wrong reaches the user's terminal at once.
async function handleRequest(line, show) {
    let request;
    try {
        request = JSON.parse(line);
    } catch (err) {
        logger.appendLine('>>> Live server: request is not JSON: ' + err.message);
        return 'GDS Lens: the request is not valid JSON.';
    }
    if (!request || typeof request !== 'object' || typeof request.gds !== 'string') {
        logger.appendLine('>>> Live server: request has no "gds" path');
        return 'GDS Lens: the request has no "gds" path.';
    }

    const uri = uriFromKlivePath(request.gds);
    if (!uri) {
        logger.appendLine('>>> Live server: not an absolute path: ' + request.gds);
        return `GDS Lens: "${request.gds}" is not an absolute path.`;
    }
    const markersUri = request.lyrdb === undefined ? null : uriFromKlivePath(request.lyrdb);
    if (request.lyrdb !== undefined && !markersUri) {
        logger.appendLine('>>> Live server: lyrdb is not an absolute path: ' + request.lyrdb);
    }

    // What KLayout does with these has no counterpart in the viewer. Named in
    // the log, and in the reply's `info` (which kfactory prints), so their
    // absence is not a mystery. `libraries` arrives on every request, usually
    // empty, so it only counts when it lists something.
    const ignored = [];
    if (Array.isArray(request.libraries) && request.libraries.length > 0) ignored.push('libraries');
    for (const key of ['l2n', 'technology', 'markers']) {
        if (request[key] !== undefined && request[key] !== null) ignored.push(key);
    }

    logger.appendLine('\n>>> Live server: show ' + uri.toString() +
        (markersUri ? ' with markers ' + markersUri.toString() : '') +
        (request.keep_position === false ? ' (reframed)' : ''));
    if (ignored.length > 0) logger.appendLine('    ignored: ' + ignored.join(', '));

    let outcome;
    try {
        outcome = await show({
            uri,
            markersUri,
            // klive keeps the view unless told otherwise, and so does show().
            keepPosition: request.keep_position !== false
        });
    } catch (err) {
        logger.appendLine('>>> Live server: could not show ' + uri.toString() + ': ' + err.message);
        return `GDS Lens: could not open ${request.gds}: ${err.message}`;
    }

    const info = [];
    if (outcome.markersFailed || (request.lyrdb !== undefined && !markersUri)) {
        info.push(`could not read lyrdb ${request.lyrdb}`);
    }
    if (ignored.length > 0) info.push('GDS Lens ignores ' + ignored.join(', '));
    return buildReply(outcome.type, request.gds, info.join('; '));
}

// One connection: collect text up to the first newline (it can arrive in any
// number of pieces), answer it, close. Requests are served one at a time
// through `queue`, so two quick show() calls for the same file cannot both
// decide it is not open yet and open it twice.
function serveConnection(socket, show, queue) {
    let buffered = '';
    let answered = false;
    socket.setEncoding('utf8');
    socket.setTimeout(IDLE_TIMEOUT_MS);

    socket.on('data', (chunk) => {
        if (answered) return;
        buffered += chunk;
        const newline = buffered.indexOf('\n');
        if (newline < 0) {
            if (buffered.length > MAX_REQUEST_CHARS) {
                answered = true;
                logger.appendLine('>>> Live server: request too large, dropping the connection');
                socket.end('GDS Lens: the request is too large.');
            }
            return;
        }
        answered = true;
        const line = buffered.slice(0, newline);
        queue.current = queue.current
            .then(() => handleRequest(line, show))
            .then((reply) => {
                if (!socket.destroyed) socket.end(reply);
            }, (err) => {
                logger.appendLine('>>> Live server: ' + err.stack);
                socket.destroy();
            });
    });
    socket.on('timeout', () => {
        if (answered) return;
        logger.appendLine('>>> Live server: connection sent no complete request, closing it');
        socket.destroy();
    });
    socket.on('end', () => {
        if (!answered && buffered) {
            logger.appendLine('>>> Live server: connection closed before a newline-terminated request');
        }
    });
    // Without a listener an 'error' (the client resetting the connection, say)
    // would be thrown as an uncaught exception into the extension host.
    socket.on('error', (err) => {
        logger.appendLine('>>> Live server: connection error: ' + err.message);
    });
}

// Starts the server under the GDS-Lens.liveServer.* settings and keeps it in
// step with them. `show({ uri, markersUri, keepPosition })` resolves to
// `{ type: 'open' | 'reload', markersFailed }` or throws with a message for
// the reply. Returns a disposable, or null when this host has no `net`.
function startLiveServer({ show, net = loadNet() }) {
    if (!net) {
        logger.appendLine('>>> Live server: not available in this extension host (no TCP sockets)');
        return null;
    }

    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -100);
    status.name = 'GDS Lens Live Preview';
    // Clicking shows the log, and first tries for the port again if it was
    // taken: KLayout or another window may have let go of it since.
    status.command = 'GDS-Lens.liveServer.statusClicked';

    const queue = { current: Promise.resolve() };
    let server = null;
    let state = 'stopped';  // 'starting' | 'listening' | 'busy' | 'failed' | 'stopped'
    let port = DEFAULT_PORT;

    const settings = () => {
        const config = vscode.workspace.getConfiguration('GDS-Lens');
        const wanted = config.get('liveServer.port', DEFAULT_PORT);
        return {
            enabled: config.get('liveServer.enabled', true),
            port: Number.isInteger(wanted) && wanted > 0 && wanted < 65536 ? wanted : DEFAULT_PORT
        };
    };

    const render = () => {
        if (state === 'stopped') {
            status.hide();
            return;
        }
        if (state === 'listening') {
            status.text = `$(radio-tower) ${port}`;
            status.tooltip = `GDS Lens live preview is listening on 127.0.0.1:${port}. ` +
                `Layouts sent with show() open here. Click for the log.`;
        } else if (state === 'busy') {
            status.text = `$(debug-disconnect) ${port}`;
            status.tooltip = `GDS Lens live preview is off: port ${port} is in use, by another ` +
                `program or VS Code window. show() goes there instead. Click to try again.`;
        } else {
            status.text = `$(debug-disconnect) ${port}`;
            status.tooltip = `GDS Lens live preview could not start on port ${port}. Click for the log.`;
        }
        status.show();
    };

    const stop = () => {
        if (server) {
            server.close();
            server = null;
            logger.appendLine('>>> Live server: stopped listening on port ' + port);
        }
        state = 'stopped';
    };

    const start = () => {
        stop();
        const wanted = settings();
        port = wanted.port;
        if (!wanted.enabled) {
            render();
            return;
        }
        const candidate = net.createServer((socket) => serveConnection(socket, show, queue));
        candidate.on('error', (err) => {
            if (server !== candidate) return;  // superseded by a restart
            server = null;
            if (err.code === 'EADDRINUSE') {
                state = 'busy';
                logger.appendLine(`>>> Live server: port ${port} is in use (another program or ` +
                    'VS Code window); not listening. show() goes to whichever has it.');
            } else {
                state = 'failed';
                logger.appendLine(`>>> Live server: could not listen on port ${port}: ${err.message}`);
            }
            candidate.close();
            render();
        });
        // 127.0.0.1 only, the address kfactory connects to: nothing off this
        // machine can reach it.
        candidate.listen(port, '127.0.0.1', () => {
            if (server !== candidate) return;
            state = 'listening';
            logger.appendLine(`>>> Live server: listening on 127.0.0.1:${port}`);
            render();
        });
        server = candidate;
        state = 'starting';
    };

    // Only a busy or failed server is retried: a listening one has the port,
    // and a stopped one was turned off on purpose.
    const retryIfDown = () => {
        if (state === 'busy' || state === 'failed') start();
    };

    const subscriptions = [
        status,
        vscode.commands.registerCommand('GDS-Lens.liveServer.statusClicked', () => {
            retryIfDown();
            logger.show(true);
        }),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('GDS-Lens.liveServer')) start();
        }),
        // The window you switch to takes the port if whatever held it has let
        // go, so with several windows open the live preview follows the one
        // in use rather than staying with whichever started first. A window
        // that has the port keeps it until it closes.
        vscode.window.onDidChangeWindowState((windowState) => {
            if (windowState.focused) retryIfDown();
        })
    ];

    start();

    return {
        // For tests: the current state and port.
        get state() { return state; },
        get port() { return port; },
        dispose() {
            stop();
            for (const subscription of subscriptions) subscription.dispose();
        }
    };
}

module.exports = {
    KLIVE_VERSION,
    KLAYOUT_VERSION,
    uriFromKlivePath,
    buildReply,
    handleRequest,
    startLiveServer
};
