/**
 * Runtime compatibility for deployments that upgrade the extension and the DSH
 * installation separately.
 * @module @deepseek-ai/dsh-vscode/host/compat
 */
import { satisfies, valid } from 'semver'

/** Compatibility verdict for one installed runtime. */
export interface RuntimeCompatibility {
  /** Whether the runtime satisfies the extension's declared range. */
  readonly ok: boolean
  /** Human-readable verdict, safe for diagnostics and the status bar. */
  readonly detail: string
}

/**
 * Check the installed DSH runtime against the extension's declared range.
 * @param version - runtime version read from the installation, when available.
 * @param range - range declared by the extension manifest.
 * @returns the verdict; an unreadable version is not compatible.
 */
export function runtimeCompatibility(version: string | undefined, range: string | undefined): RuntimeCompatibility {
  if (range === undefined || range === '') {
    return { ok: true, detail: 'no runtime range declared' }
  }
  if (version === undefined) {
    return { ok: false, detail: `runtime version unknown; expected ${range}` }
  }
  const normalized = valid(version) ?? valid(version.trim())
  if (normalized === null) {
    return { ok: false, detail: `runtime version ${JSON.stringify(version)} is not semver; expected ${range}` }
  }
  return satisfies(normalized, range, { includePrerelease: true })
    ? { ok: true, detail: `${normalized} satisfies ${range}` }
    : { ok: false, detail: `${normalized} does not satisfy ${range}` }
}
