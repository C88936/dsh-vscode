/**
 * Size limits one Webview transport and the Host bridge enforce.
 *
 * The limits travel from the extension's `dsh.limits.*` settings, through the
 * launch payload, to the page: the Host approves package assets and binary
 * answers, and the page bounds the unary request bodies it sends. Keeping one
 * record for both halves means a deployment raises a budget once instead of in
 * two independent constants.
 *
 * @module @deepseek-ai/dsh-vscode/shared/limits
 */

/** Every bounded transfer between the page and the Host, in bytes or item counts. */
export interface BridgeLimits {
  /** Largest text body one unary Webview request may carry. */
  readonly unaryBodyBytes: number
  /** Largest number of published assets one package may contribute in one launch. */
  readonly packageAssetCount: number
  /** Largest single package asset copied into the launch directory. */
  readonly packageAssetBytes: number
  /** Largest total of package assets copied into one launch directory. */
  readonly packageAssetTotalBytes: number
  /** Largest response body one opt-in binary Webview answer carries. */
  readonly binaryResponseBytes: number
}

/** Limits used when a setting is unset, so a launch never starts without budgets. */
export const DEFAULT_BRIDGE_LIMITS: BridgeLimits = {
  unaryBodyBytes: 8 * 1024 * 1024,
  packageAssetCount: 256,
  packageAssetBytes: 2 * 1024 * 1024,
  packageAssetTotalBytes: 32 * 1024 * 1024,
  binaryResponseBytes: 5 * 1024 * 1024,
}

/** Setting names, without the `dsh.` prefix, for each limit the deployment may change. */
export const BRIDGE_LIMIT_SETTINGS: Readonly<Record<keyof BridgeLimits, string>> = {
  unaryBodyBytes: 'limits.unaryBodyBytes',
  packageAssetCount: 'limits.packageAssetCount',
  packageAssetBytes: 'limits.packageAssetBytes',
  packageAssetTotalBytes: 'limits.packageAssetTotalBytes',
  binaryResponseBytes: 'limits.binaryResponseBytes',
}

/**
 * Read one reported limit.
 * @param value - value read from configuration or a decoded payload.
 * @returns the value when it is a positive integer, otherwise undefined.
 */
export function bridgeLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * Resolve every limit from configuration, reporting each value it refuses.
 *
 * An unset limit keeps its default. A value that is not a positive integer is
 * ignored with one diagnostic instead of silently becoming zero or unbounded.
 * @param read - reads one setting by its name below `dsh`.
 * @param report - receives one diagnostic line per refused value.
 * @returns the limits this launch enforces.
 */
export function resolveBridgeLimits(
  read: (key: string) => unknown,
  report: (line: string) => void,
): BridgeLimits {
  const resolved: { -readonly [K in keyof BridgeLimits]: number } = { ...DEFAULT_BRIDGE_LIMITS }
  const entries = Object.entries(BRIDGE_LIMIT_SETTINGS) as [keyof BridgeLimits, string][]
  for (const [name, key] of entries) {
    const value = read(key)
    if (value === undefined) continue
    const accepted = bridgeLimit(value)
    if (accepted === undefined) {
      report(`dsh: ignoring dsh.${key}: it must be a positive integer, so the default ${String(DEFAULT_BRIDGE_LIMITS[name])} applies`)
      continue
    }
    resolved[name] = accepted
  }
  return resolved
}

/**
 * Validate the limits one launch payload carries.
 *
 * The payload crosses a process boundary (the companion writes it as JSON), so
 * a missing or malformed record is refused rather than read field by field.
 * @param value - decoded `limits` value.
 * @returns the limits, or undefined when the record is incomplete.
 */
export function readBridgeLimits(value: unknown): BridgeLimits | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const entries = Object.keys(BRIDGE_LIMIT_SETTINGS) as (keyof BridgeLimits)[]
  const limits: { -readonly [K in keyof BridgeLimits]: number } = { ...DEFAULT_BRIDGE_LIMITS }
  for (const name of entries) {
    const accepted = bridgeLimit(record[name])
    if (accepted === undefined) return undefined
    limits[name] = accepted
  }
  return limits
}
