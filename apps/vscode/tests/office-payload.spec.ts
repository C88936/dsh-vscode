/** Incomplete authoring payloads must never qualify for standalone packaging. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  OFFICE_PAYLOAD_COMMAND,
  requireOfficePayload,
  requireOfficePayloadDirectory,
  verifyOfficePayload,
} from '../scripts/office-payload.mjs'
import lock from '../../../scripts/primary-runtime/lock.json' with { type: 'json' }

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function payload(fields: object): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-office-payload-test-'))
  roots.push(root)
  mkdirSync(join(root, 'primary-runtime'))
  writeFileSync(join(root, 'primary-runtime/runtime.json'), JSON.stringify(fields))
  return root
}

it('names the missing staged record and the command that builds it', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-office-payload-test-'))
  roots.push(root)
  expect(() => verifyOfficePayload(root)).toThrow(/primary-runtime[\\/]runtime\.json/u)
  expect(() => verifyOfficePayload(root)).toThrow(/Office authoring payload is missing/u)
  expect(() => verifyOfficePayload(root)).toThrow(OFFICE_PAYLOAD_COMMAND)
})
it('requires a prepared payload directory before it is copied', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-office-payload-test-'))
  roots.push(root)
  expect(() => requireOfficePayloadDirectory(root)).toThrow(OFFICE_PAYLOAD_COMMAND)
})
it('returns the payload directory once its record exists', () => {
  const root = payload({ platform: 'win32', arch: 'x64' })
  expect(requireOfficePayload(root)).toBe(join(root, 'primary-runtime'))
})
it('rejects a foreign platform', () => {
  expect(() => verifyOfficePayload(payload({ platform: 'darwin', arch: 'arm64' }))).toThrow('win32-x64')
})
it('rejects a payload missing pinned document libraries', () => {
  expect(() => verifyOfficePayload(payload({ platform: 'win32', arch: 'x64', python: lock.pythonVersion,
    payloadDigest: 'a'.repeat(64), pythonPackages: {} }))).toThrow('missing pinned')
})
it('rejects metadata without its interpreter', () => {
  expect(() => verifyOfficePayload(payload({ platform: 'win32', arch: 'x64', python: lock.pythonVersion,
    payloadDigest: 'a'.repeat(64), pythonPackages: lock.pythonPackages }))).toThrow()
})
