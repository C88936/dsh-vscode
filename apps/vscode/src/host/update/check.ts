/**
 * Whether one published feed applies to this window.
 *
 * The check answers four independent questions and stops at the first one that fails, so the reported reason names the
 * single fact a publisher or an operator must change: the extension identity, the version ordering, the VS Code engine
 * range, and the target platform. Ordering follows semver precedence, so a prerelease outranks only an earlier
 * prerelease of the same version.
 * @module @deepseek-ai/dsh-vscode/host/update/check
 */
import { gt, satisfies, valid } from 'semver'
import type { UpdateManifest } from './manifest.ts'

/** Why one feed does not apply to this window. */
export type UpdateIneligibleCode = 'extension-id' | 'version' | 'engine' | 'platform'

/** A feed that applies to this window. */
export interface AvailableUpdate {
  /** The validated feed. */
  readonly manifest: UpdateManifest
  /** Version the feed publishes, normalized to strict semver. */
  readonly version: string
  /** Extension version this window runs. */
  readonly localVersion: string
}

/** Inputs for one eligibility decision. */
export interface EligibilityRequest {
  /** The validated feed. */
  readonly manifest: UpdateManifest
  /** Identifier of the installed extension, as `publisher.name`. */
  readonly extensionId: string
  /** Version of the installed extension. */
  readonly localVersion: string
  /** Version of the VS Code this window runs. */
  readonly vscodeVersion: string
  /** Platform of this window, as `<platform>-<arch>`, for example `win32-x64`. */
  readonly targetPlatform: string
}

/** Outcome of one eligibility decision. */
export type EligibilityResult =
  | { readonly eligible: true; readonly update: AvailableUpdate }
  | { readonly eligible: false; readonly code: UpdateIneligibleCode; readonly reason: string }

/**
 * @returns the target platform of the running window, in the form a feed publishes.
 */
export function currentTargetPlatform(): string {
  return `${process.platform}-${process.arch}`
}

/**
 * Decide whether one feed may replace the installed extension.
 *
 * A version that equals, precedes, or only extends the build metadata of the installed one is not an update, and an
 * unreadable installed or VS Code version is reported instead of being treated as older.
 * @param request - the feed and the facts about this window.
 * @returns the applicable update, or the failed condition and its readable reason.
 */
export function evaluateUpdate(request: EligibilityRequest): EligibilityResult {
  const { manifest } = request
  if (manifest.extensionId !== request.extensionId) {
    return ineligible(
      'extension-id',
      `the feed names extension ${manifest.extensionId}, not ${request.extensionId}`,
    )
  }
  const local = valid(request.localVersion.trim())
  if (local === null) {
    return ineligible('version', `the installed version ${JSON.stringify(request.localVersion)} is not semver`)
  }
  if (!gt(manifest.version, local)) {
    return ineligible('version', `version ${manifest.version} is not newer than the installed ${local}`)
  }
  const vscode = valid(request.vscodeVersion.trim())
  if (vscode === null) {
    return ineligible('engine', `the VS Code version ${JSON.stringify(request.vscodeVersion)} is not semver`)
  }
  if (!satisfies(vscode, manifest.engines.vscode, { includePrerelease: true })) {
    return ineligible(
      'engine',
      `the feed requires VS Code ${manifest.engines.vscode}, which excludes ${vscode}`,
    )
  }
  if (manifest.targetPlatform !== 'universal' && manifest.targetPlatform !== request.targetPlatform) {
    return ineligible(
      'platform',
      `the package targets ${manifest.targetPlatform}; this window runs ${request.targetPlatform}`,
    )
  }
  return {
    eligible: true,
    update: { manifest, version: manifest.version, localVersion: local },
  }
}

/**
 * @param code - failed condition. @param reason - readable explanation naming the values that disagree.
 * @returns the ineligible result.
 */
function ineligible(code: UpdateIneligibleCode, reason: string): EligibilityResult {
  return { eligible: false, code, reason }
}
