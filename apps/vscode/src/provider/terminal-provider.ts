/**
 * VS Code terminal backend for DSH's `ctx.shell` seam.
 *
 * The module is loaded by the DSH Loader from this extension's own directory,
 * which has no `node_modules`: the base class and the terminal runner arrive
 * through globals the companion installs before boot, so the file imports
 * nothing at runtime.
 * @module @deepseek-ai/dsh-vscode/provider/terminal-provider
 */
import type { Context } from '@deepseek-ai/cordis'
import type {
  CollectedOutput,
  ShellExecRequest,
  ShellExecSpec,
  ShellExecution,
  ShellExecutor as ShellExecutorBase,
  ShellProcessRead,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell'

/** One command the extension runs in its integrated terminal. */
export interface TerminalRequest {
  readonly command: string
  readonly cwd: string
  readonly timeoutMs: number
  readonly onExpiry: 'kill' | 'none'
  readonly stdoutMaxBytes: number
  readonly env?: Record<string, string>
  readonly signal?: AbortSignal
}

/** What the extension reports once the terminal command settled. */
export interface TerminalOutcome {
  readonly output: string
  readonly exitCode: number | undefined
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly truncated: boolean
}

/** Terminal runner the companion installs on the global object. */
interface TerminalRunner {
  run(request: TerminalRequest): Promise<TerminalOutcome>
}

/** Globals the companion owns before the Loader mounts this row. */
interface ProviderGlobals {
  __DSH_VSCODE_SHELL_BASE__?: typeof ShellExecutorBase
  __DSH_VSCODE_TERMINAL__?: TerminalRunner
}

const globals = globalThis as ProviderGlobals
const installedBase = globals.__DSH_VSCODE_SHELL_BASE__
const installedRunner = globals.__DSH_VSCODE_TERMINAL__
if (installedBase === undefined) throw new Error('vscode shell: the shell base class was not installed')
if (installedRunner === undefined) throw new Error('vscode shell: the terminal runner was not installed')
const Base = installedBase
const runner = installedRunner

/** Default timeout when the caller supplies none. */
const DEFAULT_TIMEOUT_MS = 120_000
/** Default foreground stdout budget. */
const DEFAULT_STDOUT_BYTES = 1024 * 1024

/**
 * Offset reader over captured text.
 * @param text - captured stream.
 * @returns a reader that answers the subprocess offset contract.
 */
function reader(text: string, truncated = false): { readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean } } {
  const bytes = Buffer.from(text, 'utf8')
  return {
    readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean } {
      const slice = bytes.subarray(Math.min(fromByte, bytes.length))
      return { text: slice.toString('utf8'), nextOffset: bytes.length, lossy: truncated }
    },
  }
}

/**
 * @param text - captured stream.
 * @returns the collected-output value DSH reports.
 */
function collected(text: string, truncated = false): CollectedOutput {
  return { text, truncated }
}

/**
 * Run DSH shell calls in the VS Code integrated terminal.
 *
 * Sandbox policy is not enforced by the terminal; the profile disables the
 * sandboxed executors when this backend is selected, so `danger-full-access`
 * semantics apply to the user's own terminal.
 */
export default class VscodeTerminalExecutor extends Base {
  /**
   * @param ctx - plugin context; the base service publishes `ctx.shell`.
   */
  constructor(ctx: Context) {
    super(ctx)
  }

  /**
   * Fill the execution spec with this backend's defaults.
   * @param request - caller request.
   * @returns the resolved spec.
   */
  override resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes: request.stdoutMaxBytes ?? DEFAULT_STDOUT_BYTES,
      sandboxPolicy: undefined,
      ...request.signal === undefined ? {} : { signal: request.signal },
      ...request.stdin === undefined ? {} : { stdin: request.stdin },
      ...request.env === undefined ? {} : { env: request.env },
    }
  }

  /**
   * Run one command in the integrated terminal.
   * @param spec - resolved execution spec.
   * @returns the execution handle the tool consumes.
   */
  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    if (spec.stdin !== undefined) {
      throw new Error('the VS Code terminal backend does not support stdin')
    }
    const controller = new AbortController()
    const onAbort = (): void => { controller.abort(spec.signal?.reason) }
    if (spec.signal?.aborted === true) controller.abort(spec.signal.reason)
    else spec.signal?.addEventListener('abort', onAbort, { once: true })
    let outcome: TerminalOutcome
    try {
      outcome = await runner.run({
        command: spec.command,
        cwd: spec.workdir,
        timeoutMs: spec.timeoutMs,
        onExpiry: spec.onExpiry,
        stdoutMaxBytes: spec.stdoutMaxBytes,
        env: { ...spec.env, ...spec.dshEnv },
        signal: controller.signal,
      })
    } finally {
      spec.signal?.removeEventListener('abort', onAbort)
    }
    const text = truncateUtf8(outcome.output, spec.stdoutMaxBytes)
    const truncated = outcome.truncated || text.truncated
    const stdout = collected(text.text, truncated)
    const stderr = collected('')
    const resultValue: ShellRunResult = {
      exitCode: outcome.exitCode ?? null,
      signal: null,
      timedOut: outcome.timedOut,
      aborted: outcome.aborted,
      timeoutMs: spec.timeoutMs,
      stdout,
      stderr,
    }
    let drained = false
    return {
      status: outcome.timedOut || outcome.aborted ? 'killed' : 'completed',
      exitCode: resultValue.exitCode,
      signal: null,
      done: Promise.resolve(),
      readOutput(): ShellProcessRead {
        if (drained) return { delta: '', lossy: false }
        drained = true
        return { delta: text.text, lossy: text.truncated }
      },
      observed: { stdout: reader(text.text, truncated), stderr: reader('') },
      kill: () => false,
      result: async () => resultValue,
    }
  }
}

/**
 * Bound stdout by UTF-8 bytes without decoding a partial code point as a
 * replacement character.
 * @param text - captured text.
 * @param maxBytes - permitted byte count.
 * @returns retained text and whether bytes were removed.
 */
function truncateUtf8(text: string, maxBytes: number | undefined): { text: string; truncated: boolean } {
  if (maxBytes === undefined) return { text, truncated: false }
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return { text, truncated: false }
  return { text: bytes.subarray(0, maxBytes).toString('utf8'), truncated: true }
}
