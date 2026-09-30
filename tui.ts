/**
 * TUI entrypoint.
 *
 * OpenCode resolves a local plugin's terminal entry **by path, not by the
 * `exports` map**: `Host.resolve` looks for `<plugin-dir>/tui` and asks the
 * runtime to resolve that specifier. So this file has to sit at the package
 * root and be named `tui.*`; a `package.json` `exports` entry alone is not
 * enough for a path-resolved local plugin.
 *
 * The implementation lives in `src/` so the pure decision logic in
 * `question.ts` can be unit tested without a TUI runtime.
 */
export { default } from "./src/tui.tsx"
