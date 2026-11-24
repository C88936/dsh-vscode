/** Encoding-aware grep: Chinese matches per fixture encoding, caps, cancellation, and binary exclusion. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import { callTool, encodedFixture, nativeSearchFixture, resultText } from './support/harness.ts'
import { encodeGb18030, encodeLegacy, encodeUtf8, encodeUtf8Bom, encodeUtf16Be, encodeUtf16Le } from './support/codec.ts'

/** Two-line Chinese fixture: the phrase on line 2 exercises line numbering. */
const FIRST = '第一行 中文标题'
const SECOND = '第二行 普通内容'
const TEXT = `${FIRST}\n${SECOND}\n`

/** The policy every legacy fixture resolves through. */
const POLICY = { fallback: [{ encoding: 'gbk' as const, directories: ['legacy'], extensions: ['.cls', '.bas', '.frm'] }] }

/**
 * Create one isolated fixture workspace.
 * @returns the absolute directory.
 */
async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-encoded-grep-'))
}

/**
 * Remove one fixture workspace.
 * @param dir - the absolute directory.
 */
async function removeWorkspace(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/**
 * Write the mixed-encoding fixture tree.
 * @param dir - the fixture workspace.
 * @returns the workspace-relative paths written.
 */
async function writeMixedWorkspace(dir: string): Promise<void> {
  await mkdir(join(dir, 'legacy'), { recursive: true })
  await mkdir(join(dir, 'src'), { recursive: true })
  await mkdir(join(dir, 'bin'), { recursive: true })
  await writeFile(join(dir, 'legacy', 'Main.cls'), encodeLegacy(TEXT))
  await writeFile(join(dir, 'legacy', 'Module.bas'), encodeLegacy(TEXT, 'gb2312'))
  await writeFile(join(dir, 'legacy', 'Form.frm'), encodeGb18030(TEXT))
  await writeFile(join(dir, 'src', 'Program.cs'), encodeUtf8(TEXT))
  await writeFile(join(dir, 'src', 'App.csproj'), encodeUtf8Bom(TEXT))
  await writeFile(join(dir, 'src', 'Windows.cs'), encodeUtf16Le(TEXT, true))
  await writeFile(join(dir, 'src', 'BigEndian.cs'), encodeUtf16Be(TEXT, true))
  await writeFile(join(dir, 'bin', 'Form.frx'), encodeLegacy(`${FIRST}\nalpha\n`))
}

/** The matches a completed grep call returned. */
interface Match {
  path: string
  lineNumber: number
  line: string
}

/**
 * Read the canonical matches of one successful call.
 * @param result - the settled tool result.
 * @returns the match list.
 */
function matchesOf(result: { value?: unknown }): Match[] {
  const value = result.value as { matches?: Match[] } | undefined
  return value?.matches ?? []
}

describe('grep over a mixed-encoding workspace', () => {
  it('finds the Chinese phrase in every fixture encoding with its line number', async () => {
    const workspace = await makeWorkspace()
    const fixture = await encodedFixture(workspace, POLICY)
    try {
      await writeMixedWorkspace(workspace)
      const result = await callTool(fixture, 'grep', { pattern: '普通内容', path: '.' })
      expect(result.isError).toBe(false)
      const matches = matchesOf(result)
      const byPath = new Map(matches.map(match => [match.path.replace(/\\/gu, '/').replace(/^\.\//u, ''), match]))
      for (const path of [
        'legacy/Main.cls',
        'legacy/Module.bas',
        'legacy/Form.frm',
        'src/Program.cs',
        'src/App.csproj',
        'src/Windows.cs',
        'src/BigEndian.cs',
      ]) {
        expect(byPath.get(path), path).toMatchObject({ lineNumber: 2, line: SECOND })
      }
      expect(resultText(result)).toContain('Found 7 matches')
      expect(resultText(result)).toContain('Line 2: 第二行 普通内容')
    } finally {
      await fixture.dispose()
      await removeWorkspace(workspace)
    }
  })

  it('never matches the binary .frx form resource', async () => {
    const workspace = await makeWorkspace()
    const fixture = await encodedFixture(workspace, POLICY)
    try {
      await writeMixedWorkspace(workspace)
      const chinese = await callTool(fixture, 'grep', { pattern: '中文标题', path: 'bin' })
      expect(matchesOf(chinese)).toEqual([])
      const ascii = await callTool(fixture, 'grep', { pattern: 'alpha', path: '.' })
      expect(matchesOf(ascii).map(match => match.path)).toEqual([])
    } finally {
      await fixture.dispose()
      await removeWorkspace(workspace)
    }
  })

  it('applies the include filter to candidates before resolving encodings', async () => {
    const workspace = await makeWorkspace()
    const fixture = await encodedFixture(workspace, POLICY)
    try {
      await writeMixedWorkspace(workspace)
      const result = await callTool(fixture, 'grep', { pattern: FIRST, path: '.', include: '*.cls' })
      expect(matchesOf(result)).toEqual([{ path: expect.stringContaining('Main.cls'), lineNumber: 1, line: FIRST }])
    } finally {
      await fixture.dispose()
      await removeWorkspace(workspace)
    }
  })

  it('de-duplicates a match both passes found and prefers the decoded text', async () => {
    const workspace = await makeWorkspace()
    const fixture = await encodedFixture(workspace, POLICY)
    try {
      await mkdir(join(workspace, 'legacy'))
      await writeFile(join(workspace, 'legacy', 'Both.cls'), encodeLegacy('alpha 中文标记\n'))
      const result = await callTool(fixture, 'grep', { pattern: 'alpha', path: '.' })
      const matches = matchesOf(result)
      expect(matches).toHaveLength(1)
      expect(matches[0]).toMatchObject({ lineNumber: 1, line: 'alpha 中文标记' })
    } finally {
      await fixture.dispose()
      await removeWorkspace(workspace)
    }
  })

  it('reports a capped result and says the complete result could not be saved', async () => {
    const workspace = await makeWorkspace()
    const fixture = await encodedFixture(workspace, { ...POLICY, grepMaxMatches: 1 })
    try {
      await writeMixedWorkspace(workspace)
      const result = await callTool(fixture, 'grep', { pattern: FIRST, path: '.', include: '*.cs' })
      expect(resultText(result)).toContain('Found 1 of ')
      expect(resultText(result)).toContain('The complete result could not be saved')
    } finally {
      await fixture.dispose()
      await removeWorkspace(workspace)
    }
  })

  it('fails before dispatch when the call is already aborted', async () => {
    const workspace = await makeWorkspace()
    const fixture = await encodedFixture(workspace, POLICY)
    try {
      await writeMixedWorkspace(workspace)
      const controller = new AbortController()
      controller.abort()
      const result = await callTool(fixture, 'grep', { pattern: 'alpha' }, controller.signal)
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { code: TOOL_ABORTED_BEFORE_DISPATCH } })
    } finally {
      await fixture.dispose()
      await removeWorkspace(workspace)
    }
  })

  it('matches plain UTF-8 workspaces exactly like the installed grep', async () => {
    const workspace = await makeWorkspace()
    const native = await nativeSearchFixture(workspace)
    const encoded = await encodedFixture(workspace)
    try {
      await mkdir(join(workspace, 'src'))
      await writeFile(join(workspace, 'src', 'alpha.ts'), `export const alpha = 1\n// TODO: refit alpha\n${FIRST}\n`)
      await writeFile(join(workspace, 'notes.md'), 'alpha appears here too\n')
      // ripgrep's traversal order across files is not deterministic, so parity
      // compares the match set and every line, not the emission order.
      const byKey = (matches: Match[]): Match[] => [...matches].sort((left, right) =>
        left.path.localeCompare(right.path) || left.lineNumber - right.lineNumber)
      const args = { pattern: 'alpha', path: '.' }
      const nativeResult = await callTool(native, 'grep', args)
      const encodedResult = await callTool(encoded, 'grep', args)
      expect(byKey(matchesOf(encodedResult))).toEqual(byKey(matchesOf(nativeResult)))
      expect(resultText(encodedResult)).toContain('Found 3 matches')
      expect(resultText(encodedResult)).toContain('Line 2: // TODO: refit alpha')
      const chinese = { pattern: FIRST, path: '.' }
      const nativeChinese = await callTool(native, 'grep', chinese)
      const encodedChinese = await callTool(encoded, 'grep', chinese)
      expect(byKey(matchesOf(encodedChinese))).toEqual(byKey(matchesOf(nativeChinese)))
      expect(resultText(encodedChinese)).toContain(`Line 3: ${FIRST}`)
    } finally {
      await native.dispose()
      await encoded.dispose()
      await removeWorkspace(workspace)
    }
  })

  it('exposes the same arguments and output schema the PTC transport renders', async () => {
    const workspace = await makeWorkspace()
    const native = await nativeSearchFixture(workspace)
    const encoded = await encodedFixture(workspace)
    try {
      const nativeDefinition = native.ctx.tools.get('grep')
      const encodedDefinition = encoded.ctx.tools.get('grep')
      expect(encodedDefinition?.name).toBe(nativeDefinition?.name)
      expect(encodedDefinition?.parameters).toEqual(nativeDefinition?.parameters)
      expect(encodedDefinition?.output?.schema).toEqual(nativeDefinition?.output?.schema)
    } finally {
      await native.dispose()
      await encoded.dispose()
      await removeWorkspace(workspace)
    }
  })
})
