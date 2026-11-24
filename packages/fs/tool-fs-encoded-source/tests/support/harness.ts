/**
 * Shared tool-fixture harness: one real context per mounted suite, using the
 * local filesystem, subprocess, and native executor the deployment uses.
 */
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as FsObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolFs from '@deepseek-ai/dsh-tool-fs'
import * as NativeSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as EncodedSource from '@deepseek-ai/dsh-tool-fs-encoded-source'
import type { Config } from '@deepseek-ai/dsh-tool-fs-encoded-source'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

/** One mounted fixture context. */
export interface Fixture {
  /** The context owning the mounted services and tools. */
  ctx: Context
  /** The workspace directory the fixtures resolve against. */
  dir: string
  /** The Agent stub every fixture invocation of this context uses, so observation state is keyed by one session. */
  agent: object
  /** Release the context. */
  dispose(): Promise<void>
}

/** Tool-invocation counting for stable call ids. */
let callCounter = 0

/** The tool-call signal used by fixture invocations; cancellation tests pass their own. */
const fixtureSignal = new AbortController().signal

/**
 * A structural Agent stub whose Session header carries the fixture workspace.
 * @param dir - the workspace directory.
 * @returns the stub an in-process tool call accepts.
 */
export function agentFor(dir: string): object {
  return { session: { header: { id: 'encoded-source-fixture', cwd: dir } } }
}

/**
 * Mount the shared services every fixture context needs.
 * @param dir - the workspace directory.
 * @param observation - whether to mount the observation policy.
 * @returns the wired context.
 */
async function baseContext(dir: string, observation: boolean): Promise<Context> {
  const ctx = new Context()
  provideWorkingDirectoryFixture(ctx, dir)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(LocalSubprocessRuntime)
  if (observation) await ctx.plugin(FsObservationPolicy)
  return ctx
}

/**
 * Mount the encoding-aware replacement suite.
 * @param dir - the workspace directory.
 * @param config - plugin config overrides; schemastery supplies the rest.
 * @param observation - whether to mount the observation policy.
 * @returns the mounted fixture.
 */
export async function encodedFixture(
  dir: string,
  config: Partial<Config> = {},
  observation = false,
): Promise<Fixture> {
  const ctx = await baseContext(dir, observation)
  await ctx.plugin(EncodedSource, { sampleOverCapGlobResults: true, ...config })
  const agent = agentFor(dir)
  return { ctx, dir, agent, dispose: () => ctx.fiber.dispose() }
}

/**
 * Mount the installed `read` tool alone, as the parity reference.
 * @param dir - the workspace directory.
 * @param config - read-tool config overrides.
 * @returns the mounted fixture.
 */
export async function nativeReadFixture(dir: string, config: Record<string, unknown> = {}): Promise<Fixture> {
  const ctx = await baseContext(dir, false)
  await ctx.plugin(NativeToolFs, { read: true, readImage: false, write: false, edit: false, ...config })
  const agent = agentFor(dir)
  return { ctx, dir, agent, dispose: () => ctx.fiber.dispose() }
}

/**
 * Mount the installed search suite alone, as the parity reference.
 * @param dir - the workspace directory.
 * @returns the mounted fixture.
 */
export async function nativeSearchFixture(dir: string): Promise<Fixture> {
  const ctx = await baseContext(dir, false)
  await ctx.plugin(NativeSearch, { sampleOverCapGlobResults: true })
  const agent = agentFor(dir)
  return { ctx, dir, agent, dispose: () => ctx.fiber.dispose() }
}

/**
 * Invoke one mounted tool through the shared execution pipeline.
 * @param fixture - the mounted fixture.
 * @param name - the tool name.
 * @param args - the raw tool arguments.
 * @param signal - optional cancellation signal.
 * @returns the settled tool result.
 */
export async function callTool(
  fixture: Fixture,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal = fixtureSignal,
): Promise<ToolExecutionResult> {
  return executeToolFixture(fixture.ctx, {
    signal,
    callId: ToolCallId(`encoded-source-${++callCounter}`),
    name,
    arguments: args,
    agent: fixture.agent as never,
  })
}

/**
 * Join the text blocks of one tool result.
 * @param result - the settled tool result.
 * @returns the model-facing text.
 */
export function resultText(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}
