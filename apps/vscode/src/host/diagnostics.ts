/**
 * Diagnostics for support on a private network.
 *
 * A deployment needs one place that states which extension, runtime, provider
 * and shell backend are in play; nothing here carries a credential value. The
 * endpoint line redacts credential-bearing URL parts, and the key line names
 * only the selected provider's stored credential. The package-tooling line
 * reads the installation payload, so it names the pnpm a package operation
 * actually runs rather than a second guess.
 * @module @deepseek-ai/dsh-vscode/host/diagnostics
 */
import { findPackageTooling, type PackageToolingLookup } from './boot.ts'
import type { ProviderKeyState } from './settings.ts'

/** One diagnostic input set. */
export interface DiagnosticsInput {
  /** Extension version from its manifest. */
  readonly extensionVersion: string
  /** How the application runs. */
  readonly mode: string
  /** Working directory the application received. */
  readonly cwd: string
  /** Harness home in use. */
  readonly home: string
  /** Installation the runtime was resolved from. */
  readonly installAnchor: string
  /** Version of that installation, when it could be read. */
  readonly runtimeVersion: string | undefined
  /** Selected provider shape. */
  readonly providerMode: string
  /** Route name for a private provider. */
  readonly providerRoute: string
  /** Private endpoint root, when configured. */
  readonly providerBaseUrl: string | undefined
  /** Stored credential state of the selected provider shape. */
  readonly providerKey: ProviderKeyState
  /** Shell backend. */
  readonly terminalBackend: string
  /** Runtime range verdict. */
  readonly runtimeDetail: string
}

/**
 * Render the diagnostic report.
 * @param input - collected facts.
 * @returns one line per fact, in a stable order.
 */
export function formatDiagnostics(input: DiagnosticsInput): string[] {
  return [
    `extension: ${input.extensionVersion}`,
    `mode: ${input.mode}`,
    `runtime: ${input.runtimeVersion ?? 'unknown'} (${input.installAnchor})`,
    formatPackageTooling(findPackageTooling(input.installAnchor)),
    `harness home: ${input.home}`,
    `working directory: ${input.cwd}`,
    `provider: ${input.providerMode}${input.providerMode === 'deepseek' ? '' : ` route=${input.providerRoute}`}`,
    ...input.providerBaseUrl === undefined ? [] : [`provider endpoint: ${redactProviderUrl(input.providerBaseUrl)}`],
    `provider key: ${input.providerKey.stored ? 'stored' : 'missing'} in VS Code SecretStorage (${input.providerKey.envName})`,
    'provider key alternatives: managed credentials, environment values, and .env files are not checked',
    `shell backend: ${input.terminalBackend}`,
    `runtime compatibility: ${input.runtimeDetail}`,
  ]
}

/**
 * Describe the package tooling a package operation runs.
 * @param lookup - result of locating the installation's pnpm payload.
 * @returns one line naming the pnpm version and entry, or why none was found.
 */
export function formatPackageTooling(lookup: PackageToolingLookup): string {
  if ('problem' in lookup) return `package tooling: unavailable (${lookup.problem})`
  return `package tooling: pnpm ${lookup.tooling.version} (${lookup.tooling.entry})`
}

/**
 * Remove credential-bearing userinfo from a provider URL for logs and reports.
 * @param value - configured endpoint.
 * @returns the URL with any username or password replaced, or a fixed marker when it cannot be parsed.
 */
export function redactProviderUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return '<unparsable URL>'
  }
  if (parsed.username === '' && parsed.password === '') return value
  parsed.username = 'redacted'
  parsed.password = ''
  return parsed.toString()
}
