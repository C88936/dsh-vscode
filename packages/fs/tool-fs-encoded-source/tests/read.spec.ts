/** Read parity with the installed tool, plus the legacy read-only observation rule. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { callTool, encodedFixture, nativeReadFixture, resultText } from './support/harness.ts'
import type { Fixture } from './support/harness.ts'
import { encodeLegacy, encodeUtf8, encodeUtf8Bom } from './support/codec.ts'

/** Chinese fixture text for the legacy read. */
const CHINESE = '第一行 中文标题\n第二行 普通内容\n第三行 结束\n'

/**
 * Create one isolated fixture workspace.
 * @returns the absolute directory.
 */
async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-encoded-read-'))
}

/**
 * Remove one fixture workspace.
 * @param dir - the absolute directory.
 */
async function removeWorkspace(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/**
 * The registered definition of one tool, failing loudly when it is absent.
 * @param ctx - the mounted fixture context.
 * @param name - the tool name.
 * @returns the registered definition.
 */
function definitionOf(ctx: Context, name: string): ToolDefinition {
  const definition = ctx.tools.get(name)
  if (definition === undefined) throw new Error(`tool "${name}" is not registered`)
  return definition
}

/**
 * Project the persisted result metadata of one successful call.
 * @param fixture - the mounted fixture.
 * @param name - the tool name.
 * @param args - the arguments the call used.
 * @param value - the canonical result value.
 * @returns the presentation metadata.
 */
function presentationMetaOf(fixture: Fixture, name: string, args: Record<string, unknown>, value: unknown): unknown {
  const project = definitionOf(fixture.ctx, name).output.presentationMeta
  if (project === undefined) throw new Error(`tool "${name}" declares no presentation metadata`)
  return project(args, value as never)
}

/**
 * Run one completed call through the tool's result presenter.
 * @param fixture - the mounted fixture.
 * @param name - the tool name.
 * @param args - the arguments the call used.
 * @param result - the settled call result, used for its content and metadata.
 * @returns the presenter's view, or `undefined` when it declines.
 */
function presentResultOf(
  fixture: Fixture,
  name: string,
  args: Record<string, unknown>,
  result: ToolExecutionResult,
): unknown {
  const present = definitionOf(fixture.ctx, name).presentResult
  if (present === undefined) throw new Error(`tool "${name}" declares no result presenter`)
  const meta = presentationMetaOf(fixture, name, args, result.isError ? undefined : result.value)
  return present(args, { content: result.content, isError: result.isError, meta: meta as never })
}

/**
 * Create the fixture files a parity case reads.
 * @param dir - the fixture workspace.
 * @returns the relative paths written.
 */
async function writeUtf8Workspace(dir: string): Promise<void> {
  const lines = Array.from({ length: 40 }, (_, index) => `第${index + 1}行 中文内容 with ascii ${index + 1}`)
  await writeFile(join(dir, 'plain.cs'), `${lines.join('\n')}\n`, 'utf8')
  await writeFile(join(dir, 'bom.csproj'), encodeUtf8Bom(`${lines.join('\n')}\n`))
  await writeFile(join(dir, 'short.txt'), 'alpha\nbeta\n')
  await writeFile(join(dir, 'empty.txt'), '')
}

describe('read parity with the installed tool', () => {
  it.each([
    ['plain.cs', {}],
    ['plain.cs', { offset: 3, limit: 4 }],
    ['plain.cs', { offset: 40, limit: 5 }],
    ['plain.cs', { limit: 2 }],
    ['bom.csproj', { offset: 2, limit: 3 }],
    ['short.txt', {}],
    ['empty.txt', {}],
  ])('renders %s with %j identically', async (name, args) => {
    const workspace = await makeWorkspace()
    const native = await nativeReadFixture(workspace)
    const encoded = await encodedFixture(workspace)
    try {
      await writeUtf8Workspace(workspace)
      const nativeResult = await callTool(native, 'read', { file_path: name, ...args })
      const encodedResult = await callTool(encoded, 'read', { file_path: name, ...args })
      expect(encodedResult.isError).toBe(nativeResult.isError)
      expect(encodedResult.value).toEqual(nativeResult.value)
      expect(resultText(encodedResult)).toBe(resultText(nativeResult))
      expect(presentationMetaOf(encoded, 'read', { file_path: name, ...args }, encodedResult.value))
        .toEqual(presentationMetaOf(native, 'read', { file_path: name, ...args }, nativeResult.value))
      expect(definitionOf(encoded.ctx, 'read').presentCall?.({ file_path: name, ...args }))
        .toEqual(definitionOf(native.ctx, 'read').presentCall?.({ file_path: name, ...args }))
      expect(presentResultOf(encoded, 'read', { file_path: name, ...args }, encodedResult))
        .toEqual(presentResultOf(native, 'read', { file_path: name, ...args }, nativeResult))
    } finally {
      await native.dispose()
      await encoded.dispose()
      await removeWorkspace(workspace)
    }
  })

  it('exposes the same arguments and output schema the PTC transport renders', async () => {
    const workspace = await makeWorkspace()
    const native = await nativeReadFixture(workspace)
    const encoded = await encodedFixture(workspace)
    try {
      const nativeDefinition = definitionOf(native.ctx, 'read')
      const encodedDefinition = definitionOf(encoded.ctx, 'read')
      expect(encodedDefinition.name).toBe(nativeDefinition.name)
      expect(encodedDefinition.parameters).toEqual(nativeDefinition.parameters)
      expect(encodedDefinition.output?.schema).toEqual(nativeDefinition.output?.schema)
    } finally {
      await native.dispose()
      await encoded.dispose()
      await removeWorkspace(workspace)
    }
  })

  it('applies the same line and byte caps', async () => {
    const workspace = await makeWorkspace()
    const caps = { readLimit: 5, readMaxLineLength: 20, readMaxBytes: 200 }
    const native = await nativeReadFixture(workspace, caps)
    const encoded = await encodedFixture(workspace, caps)
    try {
      await writeUtf8Workspace(workspace)
      const args = { file_path: 'plain.cs', limit: 5 }
      const nativeResult = await callTool(native, 'read', args)
      const encodedResult = await callTool(encoded, 'read', args)
      expect(resultText(encodedResult)).toBe(resultText(nativeResult))
      expect(resultText(encodedResult)).toContain('(line truncated to 20 chars)')
      expect(resultText(encodedResult)).toContain('(Output capped.')
      expect(encodedResult.value).toEqual(nativeResult.value)
    } finally {
      await native.dispose()
      await encoded.dispose()
      await removeWorkspace(workspace)
    }
  })

  it('fails an offset past the end of file exactly like the installed tool', async () => {
    const workspace = await makeWorkspace()
    const native = await nativeReadFixture(workspace)
    const encoded = await encodedFixture(workspace)
    try {
      await writeUtf8Workspace(workspace)
      const args = { file_path: 'short.txt', offset: 9 }
      const nativeResult = await callTool(native, 'read', args)
      const encodedResult = await callTool(encoded, 'read', args)
      expect(encodedResult.isError).toBe(true)
      expect(resultText(encodedResult)).toBe(resultText(nativeResult))
      expect(encodedResult.error).toMatchObject({ info: { code: 'FS_NOT_FOUND' } })
    } finally {
      await native.dispose()
      await encoded.dispose()
      await removeWorkspace(workspace)
    }
  })
})

describe('legacy reads', () => {
  it('returns the decoded GBK window and keeps the file unobserved', async () => {
    const workspace = await makeWorkspace()
    const fixture = await encodedFixture(workspace, {
      fallback: [{ encoding: 'gbk', directories: ['.'], extensions: ['.cls'] }],
    }, true)
    try {
      await writeFile(join(workspace, 'Form.cls'), encodeLegacy(CHINESE))
      const result = await callTool(fixture, 'read', { file_path: 'Form.cls' })
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({ path: expect.stringContaining('Form.cls'), offset: 1, totalLines: 3 })
      expect(resultText(result)).toContain('1: 第一行 中文标题')
      expect(resultText(result)).toContain('(End of file - total 3 lines)')
      const target = await fixture.ctx.fs.resolve('Form.cls', { cwd: workspace })
      const intent = await fixture.ctx.waterfall('fs/write-intent', target, { agent: fixture.agent }, () => undefined)
      expect(intent).toEqual({ kind: 'createIfAbsent' })
    } finally {
      await fixture.dispose()
      await removeWorkspace(workspace)
    }
  })

  it('records the present observation for a UTF-8 read so a later edit stays possible', async () => {
    const workspace = await makeWorkspace()
    const fixture = await encodedFixture(workspace, {}, true)
    try {
      await writeFile(join(workspace, 'Plain.cs'), encodeUtf8(CHINESE))
      await callTool(fixture, 'read', { file_path: 'Plain.cs' })
      const target = await fixture.ctx.fs.resolve('Plain.cs', { cwd: workspace })
      const intent = await fixture.ctx.waterfall('fs/write-intent', target, { agent: fixture.agent }, () => undefined)
      expect(intent).toMatchObject({ kind: 'replaceIfVersion' })
      const edit = await fixture.ctx.waterfall('fs/edit-intent', target, { agent: fixture.agent }, () => undefined)
      expect(edit).toMatchObject({ version: expect.any(String) })
    } finally {
      await fixture.dispose()
      await removeWorkspace(workspace)
    }
  })

  it('keeps a UTF-8 BOM read observed', async () => {
    const workspace = await makeWorkspace()
    const fixture = await encodedFixture(workspace, {}, true)
    try {
      await writeFile(join(workspace, 'Bom.csproj'), encodeUtf8Bom(CHINESE))
      const result = await callTool(fixture, 'read', { file_path: 'Bom.csproj' })
      expect(resultText(result)).not.toContain('\uFEFF')
      const target = await fixture.ctx.fs.resolve('Bom.csproj', { cwd: workspace })
      const intent = await fixture.ctx.waterfall('fs/write-intent', target, { agent: fixture.agent }, () => undefined)
      expect(intent).toMatchObject({ kind: 'replaceIfVersion' })
    } finally {
      await fixture.dispose()
      await removeWorkspace(workspace)
    }
  })

  it('never reads a .frx form resource as text', async () => {
    const workspace = await makeWorkspace()
    const fixture = await encodedFixture(workspace)
    try {
      await writeFile(join(workspace, 'Form.frx'), encodeLegacy(CHINESE))
      const result = await callTool(fixture, 'read', { file_path: 'Form.frx' })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { code: 'FS_NOT_TEXT' } })
    } finally {
      await fixture.dispose()
      await removeWorkspace(workspace)
    }
  })

  it('decodes a streamed legacy file when a rule names its encoding', async () => {
    const workspace = await makeWorkspace()
    const fixture = await encodedFixture(workspace, {
      rules: [{ glob: '*.cls', encoding: 'gbk', mode: 'decode' }],
      readStreamMinSize: 1,
    })
    try {
      await writeFile(join(workspace, 'Stream.cls'), encodeLegacy(CHINESE))
      const result = await callTool(fixture, 'read', { file_path: 'Stream.cls', limit: 2 })
      expect(resultText(result)).toContain('1: 第一行 中文标题')
      expect(resultText(result)).toContain('(Showing lines 1-2 of 3.')
    } finally {
      await fixture.dispose()
      await removeWorkspace(workspace)
    }
  })

  it('refuses a streamed legacy file that no rule names, because a stream cannot rewind for the fallback', async () => {
    const workspace = await makeWorkspace()
    const fixture = await encodedFixture(workspace, {
      fallback: [{ encoding: 'gbk', directories: ['.'], extensions: ['.cls'] }],
      readStreamMinSize: 1,
    })
    try {
      await writeFile(join(workspace, 'Stream.cls'), encodeLegacy(CHINESE))
      const result = await callTool(fixture, 'read', { file_path: 'Stream.cls' })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { code: 'FS_NOT_TEXT' } })
    } finally {
      await fixture.dispose()
      await removeWorkspace(workspace)
    }
  })
})
