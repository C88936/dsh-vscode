/**
 * Build the extension host entry and the webview bootstrap.
 *
 * The companion resolves DSH packages from the selected runtime. The editor
 * loads the extension entry before it can resolve that runtime, so the entry
 * bundles the semver implementation used to check runtime compatibility.
 */
import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

/** Version the webview reports as the running DSH release. */
const packageVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

export default defineConfig([
  {
    entry: {
      extension: 'src/extension.ts',
      companion: 'src/companion/main.ts',
      'terminal-provider': 'src/provider/terminal-provider.ts',
      'editor-provider': 'src/provider/editor-provider.ts',
    },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'node20',
    deps: {
      neverBundle: [/^vscode$/, /^node:/, /^@deepseek-ai\//],
      alwaysBundle: ['semver'],
    },
    dts: false,
    sourcemap: true,
    clean: false,
  },
  {
    entry: { webview: 'src/webview/main.ts' },
    outDir: 'lib',
    format: ['iife'],
    platform: 'browser',
    target: 'es2022',
    // The webview reports this as the running DSH version; packaging already
    // requires the extension and the embedded runtime to share it.
    define: { 'process.env.DSH_EXTENSION_VERSION': JSON.stringify(packageVersion) },
    dts: false,
    sourcemap: true,
    clean: false,
  },
])
