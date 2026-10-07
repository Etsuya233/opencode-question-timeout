/**
 * TUI entrypoint.
 *
 * OpenCode resolves a local plugin's terminal entry **by path, not by the
 * `exports` map**: `Host.resolve` looks for `<plugin-dir>/tui` and asks the
 * runtime to resolve that specifier. So this file has to sit at the package
 * root and be named `tui.*`; a `package.json` `exports` entry alone is not
 * enough for a path-resolved local plugin.
 *
 * It re-exports the **precompiled** `dist/tui.js`, not the source. OpenCode
 * only runs its Solid Babel transform on plugin files outside `node_modules`,
 * so an npm/git install of raw `.tsx` is compiled by Bun's default JSX
 * transform and every reactive expression in the render tree freezes at its
 * initial value — the countdown would load, reply on time, and never draw.
 * `dist/` is built by `npm run compile` and committed so git installs need no
 * build step. See `scripts/build.mjs` for the full explanation.
 */
export { default } from "./dist/tui.js"
