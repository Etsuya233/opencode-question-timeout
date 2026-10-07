/**
 * Precompiles the TUI entrypoints for distribution.
 *
 * Why this exists
 * ---------------
 * OpenCode's TUI only runs its Solid Babel transform on plugin sources that
 * live **outside** `node_modules` (the host's `bun-plugin-solid` loader filter
 * is `/^(?!.*[/\\]node_modules[/\\]).../`). A plugin installed from git or npm
 * therefore sits under `.../node_modules/...` and its raw `.tsx` is compiled by
 * Bun's default JSX transform instead, which evaluates prop expressions
 * eagerly:
 *
 *   <Show when={props.entry()}>   ->   jsx(Show, { when: props.entry() })
 *
 * `props.entry()` is then read once, at element creation, and the component
 * freezes at its initial value — the countdown silently never renders (or
 * never ticks) even though the plugin loads and its logic runs.
 *
 * This script emits the same code the host would have produced for a local
 * plugin: babel-preset-solid with `generate: "universal"`, so JSX props become
 * reactive getters, plus @babel/preset-typescript. Runtime imports stay as bare
 * specifiers (`solid-js`, `@opentui/solid`, `@opencode/plugin/tui`); OpenCode
 * rewrites those to its own runtime modules when the plugin is loaded, whether
 * it came from a path or from `node_modules`.
 *
 * `dist/` is committed so a `github:`/npm install needs no build step.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { transformAsync } from "@babel/core"
import ts from "@babel/preset-typescript"
import solid from "babel-preset-solid"

const root = dirname(fileURLToPath(new URL(".", import.meta.url)))
const srcDir = join(root, "src")
const outDir = join(root, "dist")

/** Rewrite relative `./x.ts`/`./x.tsx` specifiers to the emitted `.js` files. */
function rewriteRelativeSpecifiers(code) {
  return code
    .replace(/(\bfrom\s*["'])((?:\.\.?\/)[^"']+)\.tsx?(["'])/g, "$1$2.js$3")
    .replace(/(\bimport\s*["'])((?:\.\.?\/)[^"']+)\.tsx?(["'])/g, "$1$2.js$3")
}

const sources = (await readdir(srcDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

if (sources.length === 0) {
  console.error("build: no sources found in src/")
  process.exit(1)
}

for (const name of sources) {
  const source = join(srcDir, name)
  const code = await readFile(source, "utf8")

  const presets = []
  if (name.endsWith(".tsx")) {
    presets.push([solid, { moduleName: "@opentui/solid", generate: "universal" }])
  }
  presets.push([ts])

  const result = await transformAsync(code, {
    filename: source,
    configFile: false,
    babelrc: false,
    presets,
  })
  const output = rewriteRelativeSpecifiers(result?.code ?? code)

  const target = join(outDir, name.replace(/\.tsx?$/, ".js"))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, output.endsWith("\n") ? output : `${output}\n`)
  console.log(`${relative(root, source)} -> ${relative(root, target)}`)

  if (name.endsWith(".tsx")) {
    // Forward the types from the source so `tsc` can resolve the compiled
    // entrypoint that tui.ts re-exports.
    const declaration = `export { default } from "../src/${name}"\n`
    await writeFile(join(outDir, name.replace(/\.tsx$/, ".d.ts")), declaration)
  }
}
