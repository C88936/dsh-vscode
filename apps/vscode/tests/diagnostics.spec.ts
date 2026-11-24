/**
 * The diagnostic report carries deployment facts and no credential values,
 * including when the endpoint URL embeds userinfo. It names the package tooling
 * the configured payload supplies, never a `pnpm` resolved from `PATH`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatDiagnostics, redactProviderUrl, type DiagnosticsInput } from '../src/host/diagnostics.ts'

const workspaces: string[] = []

/**
 * Create a temporary directory tree.
 * @returns its absolute path.
 */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vscode-diagnostics-'))
  workspaces.push(dir)
  return dir
}

/**
 * Write one file below a fixture root.
 * @param root - fixture root. @param relative - path below it. @param text - file content.
 */
function file(root: string, relative: string, text: string): void {
  const target = join(root, relative)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
}

afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const input: DiagnosticsInput = {
  extensionVersion: '0.0.0',
  mode: 'companion',
  cwd: 'D:/work/project',
  home: 'C:/Users/me/globalStorage/home',
  installAnchor: 'E:/dsh/apps/cli/package.json',
  runtimeVersion: '0.2.2-alpha.2',
  providerMode: 'openai-compatible',
  providerRoute: 'company',
  providerBaseUrl: 'http://llm.lan:8000/v1',
  providerKey: { envName: 'DSH_LLM_API_KEY', stored: true },
  terminalBackend: 'local',
  runtimeDetail: '0.2.2-alpha.2 satisfies >=0.2.2-alpha.2 <0.3.0',
}

describe('formatDiagnostics', () => {
  it('states extension, runtime, provider and shell facts', () => {
    const lines = formatDiagnostics(input)
    expect(lines).toContain('runtime: 0.2.2-alpha.2 (E:/dsh/apps/cli/package.json)')
    expect(lines).toContain('provider: openai-compatible route=company')
    expect(lines).toContain('provider endpoint: http://llm.lan:8000/v1')
    expect(lines).toContain('provider key: stored in VS Code SecretStorage (DSH_LLM_API_KEY)')
    expect(lines).toContain('shell backend: local')
    expect(lines).toContain('runtime compatibility: 0.2.2-alpha.2 satisfies >=0.2.2-alpha.2 <0.3.0')
  })

  it('reports only the selected provider key state', () => {
    const lines = formatDiagnostics({ ...input, providerKey: { envName: 'DSH_LLM_API_KEY', stored: false } })
    expect(lines).toContain('provider key: missing in VS Code SecretStorage (DSH_LLM_API_KEY)')
    expect(lines).toContain('provider key alternatives: managed credentials, environment values, and .env files are not checked')
  })

  it('omits the endpoint line for the DeepSeek route', () => {
    const lines = formatDiagnostics({
      ...input,
      providerMode: 'deepseek',
      providerBaseUrl: undefined,
      providerKey: { envName: 'DEEPSEEK_API_KEY', stored: true },
    })
    expect(lines.some(line => line.startsWith('provider endpoint:'))).toBe(false)
    expect(lines).toContain('provider: deepseek')
  })

  it('redacts credential-bearing userinfo from the reported endpoint', () => {
    const lines = formatDiagnostics({ ...input, providerBaseUrl: 'https://user:secret@llm.lan:8000/v1' })
    expect(lines).toContain('provider endpoint: https://redacted@llm.lan:8000/v1')
    expect(lines.join('\n')).not.toContain('secret')
  })

  it('reports an unreadable runtime version instead of guessing', () => {
    expect(formatDiagnostics({ ...input, runtimeVersion: undefined })).toContain(
      'runtime: unknown (E:/dsh/apps/cli/package.json)',
    )
  })
})

describe('package tooling', () => {
  it('names the staged pnpm version and entry', () => {
    const root = workspace()
    file(root, 'package.json', '{"name":"@deepseek-ai/dsh-vscode-runtime"}\n')
    file(root, 'node_modules/pnpm/package.json', `${JSON.stringify({
      name: 'pnpm', version: '11.28.5', bin: { pnpm: 'bin/pnpm.mjs' },
    })}\n`)
    file(root, 'node_modules/pnpm/bin/pnpm.mjs', '')
    const lines = formatDiagnostics({ ...input, installAnchor: join(root, 'package.json') })
    expect(lines).toContain(
      `package tooling: pnpm 11.28.5 (${join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')})`,
    )
  })

  it('reports why no payload was found instead of claiming a pnpm', () => {
    const root = workspace()
    file(root, 'package.json', '{"name":"@deepseek-ai/dsh-vscode-runtime"}\n')
    const lines = formatDiagnostics({ ...input, installAnchor: join(root, 'package.json') })
    const tooling = lines.filter(line => line.startsWith('package tooling:'))
    expect(tooling).toHaveLength(1)
    expect(tooling[0]).toContain('unavailable')
    expect(tooling[0]).toContain(join(root, 'node_modules', 'pnpm'))
    expect(tooling[0]).not.toMatch(/pnpm \d/u)
  })
})

describe('redactProviderUrl', () => {
  it('leaves a URL without credentials unchanged', () => {
    expect(redactProviderUrl('http://llm.lan:8000/v1')).toBe('http://llm.lan:8000/v1')
  })

  it('replaces a username and drops a password', () => {
    expect(redactProviderUrl('https://user:secret@llm.lan/v1')).toBe('https://redacted@llm.lan/v1')
    expect(redactProviderUrl('https://token@llm.lan/v1')).toBe('https://redacted@llm.lan/v1')
  })

  it('replaces an unparsable value instead of echoing it', () => {
    expect(redactProviderUrl('not a url')).toBe('<unparsable URL>')
  })
})
