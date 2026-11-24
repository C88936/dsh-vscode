/** Public plugin management records shared with clients. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { PluginLocalizedMeta } from '@deepseek-ai/dsh-package-manifest'
import type { PluginInventoryEntry } from '@deepseek-ai/dsh-host-plugin-inventory/types'
export type { PluginEntryId } from '@deepseek-ai/dsh-host-plugin-inventory/types'
import type { PluginEntryId } from '@deepseek-ai/dsh-host-plugin-inventory/types'
import type {} from '@deepseek-ai/dsh-typert-protocol'
import type { DetailFailureReason } from '@deepseek-ai/dsh-plugin-detail/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The profile lists no such bundle, or its directory cannot be resolved. */
    'plugin-manager/unknown-bundle': { readonly name: string }
    /** The display language is not a BCP 47 language id. */
    'plugin-manager/invalid-language': { readonly language: string }
    /**
     * A bundle's detail document or image exists but cannot be read: `too-large` beyond a size limit, `network` when the
     * npm file CDNs cannot be reached, `invalid` for a malformed locale file or `meta.detail`, or a named file that does
     * not exist. Bundle files come from local directories and public CDNs, which never answer `denied`.
     */
    'plugin-manager/detail-unavailable': { readonly reason: DetailFailureReason }
  }
}

/** Reasons a profile control cannot modify its target. */
export type ReadOnlyReason = 'management-required' | 'unaddressable'

/** A package whose declared DSH requirements reject the running DSH version, without an exemption for the exact pair. */
export interface IncompatiblePlugin {
  name: string
  version: string
  runtimeVersion: string
  /** Only the requirements the running version does not satisfy, keyed `engines.dsh` or by DSH peer package name. */
  requirements: Record<string, string>
}

/** Localizable management failure and optional external diagnostic. */
export interface ManagementError {
  code: ReadOnlyReason | 'unknown-plugin' | 'invalid-spec' | 'already-installed' | 'ambiguous-install' | 'not-bundle' | 'not-removable' | 'stop-profile' | 'bundle-in-use' | 'stale-approval' | 'incompatible-version' | 'unsupported-platform' | 'unexpected-package' | 'operation-error'
  diagnostic?: string
  /** Present with `incompatible-version`: the packages the running DSH version rejects. */
  incompatible?: IncompatiblePlugin[]
}

/**
 * Why a change waits for the next start: `no-hmr` profiles apply changes only at startup; `package-moved` changes map an
 * installed package to another directory without removing it first, or change or locally override a package the DSH
 * installation provides; `host-module` changes reach
 * modules the running process itself imports; `unmanaged-plugin` changes reach a plugin running outside a Loader entry;
 * `module-comparison` means loaded modules could not be compared with disk.
 */
export type RestartReason = 'no-hmr' | 'package-moved' | 'host-module' | 'unmanaged-plugin' | 'module-comparison'

/** One running-profile entry and its persistent control availability. */
export type PluginInfo = PluginInventoryEntry & (
  | { patchId: string; readOnlyReason?: never }
  | { patchId?: never; readOnlyReason: ReadOnlyReason }
)

/** One row a bundle's patch declares, with its live entry while the bundle contributes it. */
export interface BundleRowInfo {
  /** The row id as the patch declares it. */
  rowId: string
  /** The module the row names. */
  moduleName: string
  /** Local package display metadata, including rows whose bundle is disabled. */
  meta?: PluginLocalizedMeta
  /** The Loader entry carrying this row, when exactly one live entry has its id. */
  entryId?: PluginEntryId
}

/** One shipped, profile-installed, or discoverable on-demand bundle. */
export interface BundleInfo {
  name: string
  /** Project-maintained shipped optional bundle or on-demand catalog entry, independent of installation and selection. */
  official: boolean
  /** Readable package location; on-demand catalog entries exclude undeclared transitive copies, and declared files may be missing. */
  availability: 'installation' | 'profile' | 'missing'
  /** Exact released Host version or same-checkout development link offered for an on-demand catalog entry. */
  installTarget?: { spec: string; version: string }
  version?: string
  /** Local display text with available translations or literal fallbacks, or a metadata diagnostic. */
  meta?: PluginLocalizedMeta
  /** Untranslated `description` of this bundle's package manifest. */
  description?: string
  /** Default GUI visibility after package and Host checks; selected or profile-installed bundles remain manageable. */
  listedByDefault?: boolean
  /**
   * Selected in the profile manifest; a selected bundle whose layer was skipped carries the load `error`, and none of
   * its `rows` has an `entryId`.
   */
  enabled: boolean
  /** Whether the profile declares this dependency; availability separately reports whether its files can be read. */
  installed: boolean
  /**
   * Present for a profile dependency the installation does not also supply: the spec `pnpm add` accepts, with local
   * paths made absolute and the user information of an http(s) URL removed.
   */
  source?: string
  /**
   * Whether the installation ships the bundle for the person to switch on: named by the launcher's `OPTIONAL_BUNDLES`,
   * held by the installation's dependencies, selected by no shipped template, and never removable.
   */
  optional: boolean
  removable: boolean
  /**
   * How `updateBundle` replaces the bundle, absent when it cannot: `registry` for a third-party profile dependency saved
   * as a registry spec under its own name, whose newer versions `listVersions` reads; `git` for one saved as a Git spec
   * pinned to a full commit, which updates to another commit of the same repository directory. Either needs a semver
   * manifest version and no plugin management.
   */
  update?: 'registry' | 'git'
  readOnlyReason?: ReadOnlyReason
  error?: ManagementError
  /** The rows the bundle's patch inserts, in declaration order; empty when the patch cannot be read. */
  rows: BundleRowInfo[]
  /** Ids of rows the bundle's patch changes without declaring them: the built-in rows it configures or disables. */
  overrides: string[]
}

/** A registry to install from: an http(s) URL, or null for the one pnpm's own configuration names. */
export type Registry = string | null

/** One bundle whose saved selection or files the running generation has not loaded. */
export interface BundlePendingRestart {
  /** Bundle package name. */
  readonly name: string
  /** Selection the running generation started with. */
  readonly runningEnabled: boolean
  /** Selection the profile saves now. */
  readonly savedEnabled: boolean
  /**
   * What the profile saved that this generation has not loaded.
   *
   * A selection difference carries no value; a saved install, replacement, or
   * removal names the file change so a rebuilt page can show it.
   */
  readonly change?: 'installed' | 'replaced' | 'removed'
  /** Version the running generation booted with, when the manager knows it. */
  readonly runningVersion?: string
  /** Version the profile saves now, when the change saved one. */
  readonly savedVersion?: string
  /** Content revision of the files this generation booted with. */
  readonly runningRevision?: string
  /** Content revision of the files the profile saves now. */
  readonly savedRevision?: string
}

/** The registries the manager asks: the configured first one, its fallbacks in order, and what pnpm's own configuration names. */
export interface PluginRegistries {
  readonly registry: Registry
  readonly fallbackRegistries: readonly string[]
  /** The URL pnpm's own configuration names in the profile, read from pnpm; null when it could not be read. */
  readonly resolved: string | null
}

/** How a package operation failed, read off how it ended and what it printed. */
export type PluginInstallFailureKind =
  | 'pnpm-missing'
  | 'timeout'
  | 'not-found'
  | 'no-matching-version'
  | 'network'
  | 'disk-full'
  | 'permission'
  | 'build-blocked'
  | 'integrity'
  | 'unknown'

/** Package operation completion, including Git checks and a retrieval path for unabridged diagnostics. */
export interface PackageResult {
  /** The status the run is read as having ended with; a run the manager terminated records the coerced status 1. */
  exitCode: number
  output: string
  truncated: boolean
  logPath: string
  /** Present when the run failed: what kind of failure its exit and output describe. */
  kind?: PluginInstallFailureKind
  /**
   * The run outlived its bound: the manager terminated it after it printed nothing for its silence bound, or the GitHub
   * connection check hit its deadline. Such a run reports no exit status of its own, so `exitCode` records the status
   * its failure is read as rather than a status the process returned.
   */
  timedOut?: boolean
  /** Present when a compatibility check refused the run: the packages the running DSH version rejects. */
  incompatible?: IncompatiblePlugin[]
  /**
   * Present when an `expected` check refused the run: `unexpected-package` when the run left the expected package
   * missing or at another version, or added or changed another direct dependency; otherwise `not-bundle` when the
   * expected package declares no bundle. The output names what the run installed.
   */
  unmet?: 'unexpected-package' | 'not-bundle'
}

/**
 * What a failed or cancelled package operation left in the profile, as the manager read it back. Restoring
 * `package.json` and `pnpm-lock.yaml` does not establish installed module files: a failed or cancelled operation
 * never verifies their version, and a run without a usable exit status leaves its module changes unknown.
 */
export interface ChangeRecovery {
  /** `package.json` and `pnpm-lock.yaml` hold their pre-operation content again, read back after restoration. */
  readonly filesRestored: boolean
  /** A package-manager run started, so downloaded files or module files it wrote can remain. */
  readonly modulesMayRemain: boolean
  /** The operation could not establish its result: a run's exit status was unusable, so its module changes are unknown. */
  readonly outcomeUnknown: boolean
}

/** Why reinstalling a recorded dependency did not establish its recorded version. */
export type BundleRepairProblem = 'not-installed' | 'unrecorded-version' | 'offline-store' | 'package-manager' | 'version-mismatch'

/**
 * Outcome of reinstalling the profile's recorded dependencies from the local store and checking one package.
 * `repaired` is reported only when the installed manifest declares the exact version the lockfile records, so a
 * restored file pair alone never reports a working package.
 */
export interface BundleRepairResult {
  /** Package the repair targeted. */
  readonly name: string
  /** `repaired` only after the installed manifest declares the recorded version; `failed` otherwise. */
  readonly status: 'repaired' | 'failed'
  /** Exact version the profile's `pnpm-lock.yaml` importer records for the package. */
  readonly recordedVersion?: string
  /** Version the installed package's own manifest declares after the run. */
  readonly installedVersion?: string
  /** Why the reinstall did not establish the recorded version; absent when `status` is `repaired`. */
  readonly problem?: BundleRepairProblem
  /** Package-manager diagnostics of the reinstall run, when one ran. */
  readonly packageResult?: PackageResult
  /** What a failed run left in the profile; absent when no run started or the repair succeeded. */
  readonly recovery?: ChangeRecovery
  /** The manager's own failure text, when no package-manager result records it. */
  readonly diagnostic?: string
}

/** Persisted change and independently observed application outcome. */
export interface ChangeResult {
  changed: boolean
  /** `cancelled` is an installation the caller stopped; `recovery` reports what it observed and what remains. */
  application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  /** Present with `restart-required`: why the change takes effect only at the next start. */
  restartReason?: RestartReason
  /** Last attempted step; successful installation can proceed to enablement. */
  stage: 'install' | 'enable' | 'remove'
  target: string
  enabled?: boolean
  error?: ManagementError
  /** Pre-existing inactive entries the operation left as they were. */
  warnings?: string[]
  packageResult?: PackageResult
  /** The bundle an installation added, once pnpm and the bundle check accepted it. */
  bundle?: string
  /** The installed bundle's manifest version, when declared; pnpm's `minimumReleaseAge` can make it older than the newest release. */
  version?: string
  /** Present for a local prepared package: what its v1 closure record proved for this installation. */
  prepared?: PreparedBundleClosure
  /** Exact `allowBuilds` keys awaiting explicit script approval in the profile's pnpm settings, read after a failed run. */
  pendingBuilds?: string[]
  /** Package script permissions saved before this installation attempt. */
  approvedBuilds?: string[]
  /** Present when the operation failed or was cancelled after it snapshotted the profile files. */
  recovery?: ChangeRecovery
  /** The registries the installation asked, in order; `packageResult` is the last one's run. */
  registries?: Registry[]
  /**
   * What the last failed run could not reach or get an answer from: the registry it asked, or the host a git or
   * tarball spec is fetched from, which no registry stands in for; absent for a failure neither explains.
   */
  failedAt?: 'registry' | 'spec-host'
}

/** Identifies one installation from its start to its settlement, including its log chunks and cancellation. */
export type PluginInstallRequestId = Branded<'PluginInstallRequestId'>

/** One dependency a prepared bundle's closure record proves installed beside the package. */
export interface PreparedBundlePackage {
  readonly name: string
  readonly version: string
}

/** One peer dependency the prepared package declares. */
export interface PreparedBundlePeer {
  readonly name: string
  readonly range: string
  /** Whether `peerDependenciesMeta` marks the peer optional. */
  readonly optional: boolean
}

/** Why a prepared bundle's offline requirement is not proven, or which item the v1 format does not support. */
export type PreparedBundleProblemKind = 'missing' | 'unsupported' | 'unproven'

/** One missing, unsupported, or unverifiable item in a prepared bundle's dependency closure. */
export interface PreparedBundleProblem {
  readonly kind: PreparedBundleProblemKind
  /** The package, file, or dependency the problem names. */
  readonly name: string
  readonly reason: string
}

/**
 * What a prepared bundle's `dsh-prepared-bundle/v1` record proves, read without installing anything. `offline` is
 * `proven` only when every metadata check passed; any problem keeps the bundle off the guaranteed-offline path, and
 * the problems name each gap. The other two verdicts are separate because the reader cannot establish them: it never
 * inspects the target pnpm store and never imports the candidate's modules.
 */
export interface PreparedBundleClosure {
  /** The understood record format; null for an absent or unknown record, which proves nothing. */
  readonly format: 'dsh-prepared-bundle/v1' | null
  /** Whether the package carries a `dsh-prepared-bundle.json` record at all. */
  readonly recorded: boolean
  /** Whether the declared and transitive closure agrees with the record, lockfile, and installed copies. */
  readonly offline: 'proven' | 'not-proven'
  /**
   * Whether the target installation's pnpm store already holds the closure. The reader only opens the bundle, so a
   * proven closure still installs with `--offline` and the store gap appears as pnpm's failure.
   */
  readonly store: 'unverified'
  /** Whether the package's modules import. Nothing is imported before installation; the next launch loads them. */
  readonly loadable: 'unverified'
  /** SHA-256 of every file the package carries; an install refuses bytes that no longer match an inspection. */
  readonly fingerprint: string
  /** Dependencies the record lists as installed beside the package, in record order. */
  readonly packages: readonly PreparedBundlePackage[]
  /** Dependencies the record declares the profile or installation supplies; the record does not verify them. */
  readonly hostProvided: readonly string[]
  readonly peers: readonly PreparedBundlePeer[]
  /** Closure packages whose lock data records install scripts; installing them still needs the profile's approval. */
  readonly installScripts: readonly string[]
  /** Closure packages whose lock data constrains the host platform. */
  readonly native: readonly string[]
  /** Every reason the offline requirement is not proven, or an unsupported item found; empty when proven. */
  readonly problems: readonly PreparedBundleProblem[]
}

/** What an earlier prepared-local inspection read, so the install can refuse a package that changed since. */
export interface PreparedBundleExpectation {
  /** Exact package name `inspect` answered; the install refuses a package that now names another. */
  readonly name?: string
  /** Exact version `inspect` answered. */
  readonly version?: string
  /** The `prepared.fingerprint` `inspect` answered. */
  readonly fingerprint?: string
  /** Require a proven offline closure: an unproven one is refused before pnpm runs. */
  readonly requireOffline?: boolean
}

/** Bundle installation defaults to activation; callers that offer cancellation supply their request id. */
export interface InstallBundleOptions {
  enabled?: boolean
  /** Save the resolved dependency version without a range; applies to any bundle installation. */
  saveExact?: boolean
  requestId?: PluginInstallRequestId
  /** Explicitly allow these pending packages' scripts for this profile, then install; a name no longer pending refuses the call. */
  approvedBuilds?: string[]
  /** The registry asked first; absent, the configured one. The configured fallbacks follow while a registry is unreachable or stale. */
  registry?: Registry
  /**
   * What a prepared-local inspection read. A local directory or archive whose manifest or closure record no longer
   * matches is refused before pnpm runs; `requireOffline` also refuses a closure the record does not prove.
   */
  prepared?: PreparedBundleExpectation
  /**
   * The package and manifest version the spec must install. An installation that leaves this package missing or at
   * another version, or that adds or changes another direct dependency, is undone with its profile files and modules
   * before its bundle loads, and fails with `unexpected-package`; one whose package declares no bundle is undone the
   * same way and fails with `not-bundle`, and one whose bundle patches cannot load fails as an operation error.
   */
  expected?: { readonly name: string; readonly version: string }
}

/** Where an inspection asks. */
export interface InspectOptions {
  /** The registry asked first; absent, the configured one. */
  readonly registry?: Registry
  /**
   * Read a local directory's or archive's own manifest even when the profile already knows its package, so a prepared
   * replacement can name the package and version before anything installs. A spec whose package is unknown reads the
   * same either way. The answer then also carries the package's `prepared` closure facts and the installed
   * `installedVersion` it would replace. Without this option a known package name is refused with `already-installed`,
   * as a typed install asks.
   */
  readonly preparedLocal?: boolean
}

/** The form one install spec takes, in pnpm's vocabulary. */
export type InstallSpecKind = 'registry' | 'path' | 'git' | 'tarball'

/** Why a spec was refused before anything installed. */
export type PluginInspectProblem =
  | 'invalid-spec'
  | 'already-installed'
  | 'not-found'
  | 'not-a-package'
  | 'not-a-bundle'
  | 'network'
  | 'unknown'

/**
 * What a spec names, read before installing it: the registry's answer for a
 * name, a directory's manifest for a path, and only the form for a git or
 * tarball spec, whose package is known once pnpm has fetched it. A local
 * archive read as a prepared bundle carries its own manifest instead.
 */
export type PluginSpecInspection =
  | {
    readonly status: 'accepted'
    readonly kind: InstallSpecKind
    readonly name?: string
    readonly version?: string
    /** `description` of the package manifest. */
    readonly description?: string
    /**
     * Names of the runtime dependencies the package manifest declares, when the inspected form carries a readable
     * manifest: a prepared local directory or archive. Absent for a registry, git, or remote tarball answer, whose
     * dependencies the package manager resolves.
     */
    readonly dependencies?: readonly string[]
    /** The installed version this package replaces, when the profile or the installation supplies one. */
    readonly installedVersion?: string
    /** The running DSH version's rejection of this package, when its requirements are not exempted. */
    readonly incompatible?: IncompatiblePlugin
    /** Present for a local directory or archive read with `preparedLocal`: what its closure record proves. */
    readonly prepared?: PreparedBundleClosure
    /** Whether the package declares a bundle patch; null when the spec's form does not say. */
    readonly bundle: boolean | null
    /** The registry that answered for a name, and for the other forms the one an install of the spec asks first. */
    readonly registry: Registry
    /** The host a git spec or a tarball URL is fetched from, which no registry stands in for. */
    readonly host?: string
  }
  | {
    readonly status: 'refused'
    readonly problem: PluginInspectProblem
    /** What pnpm, the registry, or the file system said. */
    readonly reason: string
    /** The registries asked, in order, when the refusal came from asking them; `reason` is the last one's. */
    readonly registries?: Registry[]
  }

/** One registry a lookup asked, in order; the registry that answered carries no problem. */
export interface RegistryAttempt {
  readonly registry: Registry
  /** Why this registry gave no usable answer; absent for the registry that answered. */
  readonly problem?: 'not-found' | 'network' | 'unknown'
  /** What pnpm or the registry said, verbatim. */
  readonly reason?: string
}

/** One published version newer than the installed one. */
export interface PluginVersion {
  readonly version: string
  /** The registry's publication time, as an ISO 8601 string. */
  readonly publishedAt?: string
  /** The dist-tags pointing at this version, such as `latest`. */
  readonly tags: readonly string[]
  /** Whether the version carries a semver prerelease suffix. */
  readonly prerelease: boolean
  /** The registry's deprecation message, when the version is deprecated. */
  readonly deprecated?: string
  /** Whether the version declares a `dsh.bundle`; a version that does not cannot replace a bundle. */
  readonly bundle: boolean
  /** Present when the version's `engines.dsh` or DSH peers reject the running DSH version without an exemption for the exact pair. */
  readonly incompatible?: IncompatiblePlugin
}

/** The versions a registry offers for an installed registry package, read without changing the profile. */
export type PluginVersionList =
  | {
    readonly status: 'listed'
    /** The installed version the list is newer than. */
    readonly installed: string
    /** The registry that answered; an update installs from it. */
    readonly registry: Registry
    readonly attempts: readonly RegistryAttempt[]
    /** Published versions newer than `installed`, newest first, at most `versionListLimit` of them. */
    readonly versions: readonly PluginVersion[]
    /** Newer versions beyond `versionListLimit` that the list leaves out. */
    readonly omitted: number
  }
  | {
    readonly status: 'refused'
    /** `not-updatable`: the package is not an installed profile dependency resolved from a registry. */
    readonly problem: 'not-updatable' | 'not-found' | 'network' | 'unknown'
    readonly reason: string
    /** The registries asked, in order; empty for `not-updatable`. */
    readonly attempts: readonly RegistryAttempt[]
  }

/** Where a version listing asks. */
export interface ListVersionsOptions {
  /** The registry asked first; absent, the one this process last installed the package from, else the configured one. */
  readonly registry?: Registry
}

/** Where an update asks for its target, and the request id its progress names. */
export interface UpdateBundleOptions {
  /** The registry asked first, normally the one that answered `listVersions`; absent, as for `listVersions`. */
  readonly registry?: Registry
  /**
   * The Git spec of the target version: required for a bundle listed with `update: 'git'`, where it must pin a full
   * commit of the installed copy's repository directory, and refused for any other.
   */
  readonly spec?: string
  /** Names the update's progress and the target installation's logs; `cancelInstall` stops only that installation. */
  readonly requestId?: PluginInstallRequestId
}

/** The step of an update its Host progress names. */
export type PluginUpdateStep = 'checking' | 'removing' | 'installing' | 'restoring'

/** Progress of one update request. */
export interface PluginUpdateProgress {
  readonly requestId: PluginInstallRequestId
  readonly step: PluginUpdateStep
}

/**
 * How an update ended. `result` belongs to the last step that ran: the target check, the removal of the installed
 * version, or the target's installation. `restore` is present when the target's installation failed or was cancelled
 * after the installed version was removed, and reports the reinstallation of that version.
 */
export interface PluginUpdateResult {
  readonly from: string
  readonly to: string
  readonly step: 'check' | 'remove' | 'install'
  readonly result: ChangeResult
  readonly restore?: ChangeResult
}

/** The Host phase of one installation, before its install call settles; `installing` is announced once per registry asked. */
export interface PluginInstallProgress {
  readonly requestId: PluginInstallRequestId
  readonly phase: 'installing' | 'cancelling' | 'applying'
  /** With `installing`: the registry this attempt asks, its one-based position, and how many the installation may ask. */
  readonly attempt?: { readonly registry: Registry; readonly index: number; readonly total: number }
}

/** Cancellation is confirmed only after process exit and file restoration. */
export interface PluginInstallCancellation {
  readonly status: 'cancelled' | 'too-late' | 'not-running'
}

/** One chunk of an installation run's output: a pnpm run, or the GitHub connection check that stopped it. */
export interface PluginInstallLogChunk {
  /** The installation the run belongs to, when its caller supplied a request id. */
  readonly requestId?: PluginInstallRequestId
  /** The run the chunk belongs to. */
  readonly jobId: string
  /** The command line the run executes: its command name, then its arguments. */
  readonly argv: readonly string[]
  /** The directory the run executes in: the profile directory. */
  readonly cwd: string
  readonly stream: 'stdout' | 'stderr'
  readonly text: string
  /** Present on the chunk that ends a run: its exit code, null when the run ended without one. */
  readonly exitCode?: number | null
}

/**
 * A bundle's long description: `found` with its origin, path, and Markdown; `none` when it has neither a `meta.detail`
 * file nor a README; or `unavailable` when this deployment configures no npm file CDN for an offered bundle. Images
 * resolve beside `path` through `GET /api/plugin-manager/detail-file?bundle=<name>&document=<path>&path=<destination>`.
 */
export type BundleDetail =
  | {
    readonly status: 'found'
    /** `locale` for the file locale `meta.detail` names, `readme` for the package's README. */
    readonly origin: 'locale' | 'readme'
    /** `/`-separated path of the document inside the package. */
    readonly path: string
    /** Markdown text without a byte order mark or a leading YAML front matter block. */
    readonly markdown: string
  }
  | { readonly status: 'none' }
  | {
    /** An offered bundle has no local files and this deployment reads none from the public npm file CDNs. */
    readonly status: 'unavailable'
  }

/** What changed in the profile, for consumers that show it. */
export interface PluginChange {
  /** The operation that changed it. */
  readonly reason: 'plugin' | 'bundle' | 'install' | 'remove'
}

/** Identifies one manager invocation, including time spent waiting for its profile lock. */
export type PluginOperationId = Branded<'PluginOperationId'>

/** Management facts for diagnostic consumers; recent operations do not establish a crash's cause. */
export type PluginOperation = {
  readonly id: PluginOperationId
  readonly time: string
  readonly reason: PluginChange['reason']
  /** Known entry id or parsed registry package name; unrecognized targets and raw specs are omitted. */
  readonly target: string | null
  readonly stage: ChangeResult['stage']
  readonly enabled?: boolean | undefined
  /** Request-time or resolved package version; absence means unusable or unavailable, never the latest registry version. */
  readonly version?: string | undefined
} & (
  | { readonly phase: 'started' }
  | {
    readonly phase: 'settled'
    readonly application: ChangeResult['application']
    readonly changed: boolean
    readonly errorCode?: ManagementError['code'] | undefined
    readonly restartReason?: RestartReason | undefined
  }
  /** An exception escaped the operation result; persisted or applied changes cannot be inferred. */
  | { readonly phase: 'unknown' }
)

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One manager invocation started or ended; subscribers run independently without delaying management.
     * @mode parallel
     * @param operation - Correlated operation facts; a start without an end has an unknown outcome.
     */
    'plugin-manager/operation'(operation: PluginOperation): void | Promise<void>
    /**
     * The profile's plugins, bundles, or composition changed: a manager
     * operation completed. A patch generation applied outside the manager,
     * by HMR's watcher after a CLI or hand edit, announces nothing here.
     * @mode emit
     * @param change - what changed.
     */
    'plugin-manager/changed'(change: PluginChange): void
    /**
     * One chunk of an installation run's output, streamed as the run produces it.
     * @mode emit
     * @param chunk - the chunk and the run it belongs to.
     */
    'plugin-manager/install-log'(chunk: PluginInstallLogChunk): void
    /**
     * An installation moved between its Host phases. `installing` is announced once per registry the
     * installation asks, with the attempt's registry and position; `cancelling` and `applying` once.
     * @mode emit
     * @param progress - the installation's request id and phase, with the attempt while installing.
     */
    'plugin-manager/install-state'(progress: PluginInstallProgress): void
    /**
     * An update moved to its next step: checking the target, removing the installed version, installing the target,
     * or reinstalling the removed version after the target failed. Announced once per step.
     * @mode emit
     * @param progress - the update's request id and step.
     */
    'plugin-manager/update-state'(progress: PluginUpdateProgress): void
  }
}
