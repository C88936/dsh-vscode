/**
 * VS Code terminal execution.
 *
 * This is the extension half of the terminal adapter: a command runs in the
 * integrated terminal the user can see, and shell integration reports its
 * output and exit code back to the application.
 * @module @deepseek-ai/dsh-vscode/host/terminal
 */
import * as vscode from 'vscode'

/** One finished terminal execution. */
export interface TerminalRun {
  /** Everything the shell printed for this command. */
  readonly output: string
  /** Exit code reported by shell integration, or undefined when unreported. */
  readonly exitCode: number | undefined
  /** Whether the executor deadline terminated the command first. */
  readonly timedOut: boolean
  /** Whether caller cancellation terminated the command first. */
  readonly aborted: boolean
  /** Whether output exceeded the requested byte budget. */
  readonly truncated: boolean
}

/** Inputs that shape one integrated-terminal execution. */
export interface TerminalRunOptions {
  /** Effective deadline echoed into the DSH result. */
  readonly timeoutMs?: number
  /** Whether the deadline terminates the command. */
  readonly onExpiry?: 'kill' | 'none'
  /** Caller cancellation. */
  readonly signal?: AbortSignal
  /** Explicit environment entries for the terminal. */
  readonly env?: Readonly<Record<string, string>>
  /** Maximum stdout bytes retained by the extension. */
  readonly stdoutMaxBytes?: number
}

/** Outcome of starting a terminal command; it never throws for shell failures. */
export type TerminalRunResult =
  | { readonly ok: true; readonly run: TerminalRun }
  | { readonly ok: false; readonly error: string }

/**
 * Wait for a terminal's shell integration to become available.
 * @param terminal - the terminal to watch.
 * @param timeoutMs - how long to wait.
 * @returns the integration, or undefined when it never arrived.
 */
async function waitForIntegration(
  terminal: vscode.Terminal,
  timeoutMs: number,
): Promise<vscode.TerminalShellIntegration | undefined> {
  if (terminal.shellIntegration !== undefined) return terminal.shellIntegration
  const ready = Promise.withResolvers<vscode.TerminalShellIntegration | undefined>()
  const listener = vscode.window.onDidChangeTerminalShellIntegration((event) => {
    if (event.terminal === terminal) ready.resolve(event.shellIntegration)
  })
  const timer = setTimeout(() => { ready.resolve(undefined) }, timeoutMs)
  try {
    return await ready.promise
  } finally {
    clearTimeout(timer)
    listener.dispose()
  }
}

/**
 * Remove the terminal control sequences shell integration emits.
 *
 * VS Code marks command boundaries with OSC 633 sequences; the model and the
 * transcript must see the command's own output only.
 * @param text - raw terminal output.
 * @returns output without OSC sequences.
 */
export function stripControl(text: string): string {
  // OSC 633 ... ST/BEL and any other OSC payload.
  return text
    .replaceAll(/\u001b\]633;[^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, '')
    .replaceAll(/\u001b\][^\u0007]*\u0007/gu, '')
    .replaceAll(/\r/gu, '')
}

/**
 * Run one command in the integrated terminal and collect its result.
 * @param command - command line to execute.
 * @param cwd - working directory for a new terminal.
 * @param options - deadline, cancellation, and environment.
 * @returns the collected run, or the reason it could not start.
 */
export async function runInTerminal(
  command: string,
  cwd?: string,
  options: TerminalRunOptions = {},
): Promise<TerminalRunResult> {
  if (options.signal?.aborted === true) {
    return { ok: true, run: { output: '', exitCode: undefined, timedOut: false, aborted: true, truncated: false } }
  }
  const terminal = vscode.window.createTerminal({
    name: 'DSH',
    ...cwd === undefined ? {} : { cwd },
    ...options.env === undefined ? {} : { env: options.env },
  })
  terminal.show(true)
  let firstCause: 'timeout' | 'abort' | undefined
  const terminated = Promise.withResolvers<void>()
  const terminate = (cause: 'timeout' | 'abort'): void => {
    if (firstCause !== undefined) return
    firstCause = cause
    terminal.dispose()
    terminated.resolve()
  }
  let timer: NodeJS.Timeout | undefined
  if (options.onExpiry !== 'none' && options.timeoutMs !== undefined) {
    timer = setTimeout(() => { terminate('timeout') }, options.timeoutMs)
  }
  const onAbort = (): void => { terminate('abort') }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const integration = await Promise.race([
      waitForIntegration(terminal, 10_000),
      terminated.promise.then(() => undefined),
    ])
    if (integration === undefined) {
      if (firstCause !== undefined) {
        return {
          ok: true,
          run: {
            output: '',
            exitCode: undefined,
            timedOut: firstCause === 'timeout',
            aborted: firstCause === 'abort',
            truncated: false,
          },
        }
      }
      return { ok: false, error: 'the terminal did not report shell integration' }
    }
    const execution = integration.executeCommand(command)
    const ended = Promise.withResolvers<number | undefined>()
    const endListener = vscode.window.onDidEndTerminalShellExecution((event) => {
      if (event.execution === execution) ended.resolve(event.exitCode)
    })
    let output = ''
    try {
      const read = (async (): Promise<void> => {
        for await (const chunk of execution.read()) output += chunk
      })()
      const outcome = await Promise.race([
        read.then(() => 'read' as const),
        terminated.promise.then(() => 'terminated' as const),
      ])
      if (outcome === 'terminated') {
        const bounded = truncate(stripControl(output), options.stdoutMaxBytes)
        return {
          ok: true,
          run: {
            output: bounded.text,
            exitCode: undefined,
            timedOut: firstCause === 'timeout',
            aborted: firstCause === 'abort',
            truncated: bounded.truncated,
          },
        }
      }
      const exitCode = await Promise.race([
        ended.promise,
        terminated.promise.then(() => undefined),
      ])
      const bounded = truncate(stripControl(output), options.stdoutMaxBytes)
      return {
        ok: true,
        run: {
          output: bounded.text,
          exitCode,
          timedOut: firstCause === 'timeout',
          aborted: firstCause === 'abort',
          truncated: bounded.truncated,
        },
      }
    } finally {
      endListener.dispose()
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    terminal.dispose()
  }
}

/**
 * @param text - command output.
 * @param maxBytes - optional retained-byte cap.
 * @returns retained UTF-8 text and whether the cap removed bytes.
 */
function truncate(text: string, maxBytes: number | undefined): { text: string; truncated: boolean } {
  if (maxBytes === undefined) return { text, truncated: false }
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return { text, truncated: false }
  return { text: bytes.subarray(0, maxBytes).toString('utf8'), truncated: true }
}
