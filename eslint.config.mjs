import globals from "globals";

// Since the viewer moved out into the gds-lens package, this repo is just the
// extension host plus its build script: two environments, so two blocks. The
// webview, Worker and parser blocks now live in that package's own config.

// The same set for every block: these are the mistakes worth a warning in a
// codebase this size, not a style guide.
const rules = {
    "no-const-assign": "warn",
    "no-this-before-super": "warn",
    "no-undef": "warn",
    "no-unreachable": "warn",
    // A leading underscore is this codebase's "required by the signature,
    // not used here" marker. The VS Code API hands its providers arguments
    // they have no use for, and dropping them from the parameter list would
    // change the ones that follow.
    "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    "constructor-super": "warn",
    "valid-typeof": "warn",
};

export default [
    {
        // dist/ is esbuild's bundle of our own sources plus the viewer payload
        // copied out of gds-lens, so linting it would only ever report the same
        // thing twice, or report someone else's code. .vscode-test-web/ is a
        // whole VS Code web distribution that `npm run test:web` downloads:
        // flat config doesn't skip dot-directories on its own, and its
        // multi-megabyte single-line bundles run the linter out of memory
        // rather than merely slowing it down.
        ignores: ["dist/**", ".vscode-test-web/**"],
    },
    {
        // The extension host. Pointedly *not* Node's global set: one bundle
        // serves both the desktop host and the Web Worker host vscode.dev runs
        // extensions in (see "Running on the web" in DEVELOPING.md), so the
        // globals here are the ones both provide, the web platform's minus the
        // DOM, plus CommonJS's module/require. Declaring it this way is what
        // turns a `Buffer`, `process` or `__dirname` creeping back into the
        // host into a lint warning rather than a crash that only happens on
        // the web. `vscode` is a require() away rather than a global, so it
        // needs nothing here.
        files: ["src/**/*.cjs"],
        languageOptions: {
            globals: { ...globals.worker, ...globals.commonjs },
            ecmaVersion: 2022,
            sourceType: "commonjs",
        },
        rules,
    },
    {
        // The webview-side host adapter. A plain browser <script> loaded into
        // the webview (as host.js), not part of the host bundle, so it gets
        // browser globals plus the one VS Code injects into a webview.
        files: ["src/webview-host.js"],
        languageOptions: {
            globals: { ...globals.browser, acquireVsCodeApi: "readonly" },
            ecmaVersion: 2022,
            sourceType: "script",
        },
        rules,
    },
    {
        // Build tooling. Real Node, ESM, runs on a developer's machine and
        // never ships, so none of the portability constraints above apply.
        files: ["scripts/**/*.mjs"],
        languageOptions: {
            globals: { ...globals.node },
            ecmaVersion: 2022,
            sourceType: "module",
        },
        rules,
    },
];
