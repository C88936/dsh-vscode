#!/usr/bin/env node
/**
 * Derive the Agent-preset layer of the encoded-source bundle from the shipped
 * Web presets, so replacing `read`/`grep`/`glob` stays in step with the presets
 * a deployment actually composes instead of a copy that rots.
 *
 * A Web profile keeps its agent tool rows inside `config.plugins` of the
 * `preset-standard` and `preset-ptc` rows. The Loader patch composer indexes
 * top-level rows and `group: true` children only, so those nested rows cannot be
 * patched by id; the only reachable edit is replacing each preset row's whole
 * `config`. This script performs that replacement and rewrites the two tool rows
 * inside it.
 *
 * Usage, from this directory:
 *   node prepare-presets-patch.mjs <dsh-web-app package dir> [output path]
 * Then list the output as a bundle layer (the shipped `presets.patch.yml` is the
 * current result of running this against `@deepseek-ai/dsh-web-app`).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Presets this bundle rewrites; `minimal` registers no `read`, so it is untouched. */
const PRESETS = ['standard', 'ptc']

/** Indentation of one preset row's `config:` children after the dedent. */
const CONFIG_INDENT = 4

/**
 * The replacement row every rewritten preset gains, indented like the row it is
 * inserted beside.
 * @param {number} indent - the item indentation of the surrounding plugin list.
 * @returns {string[]} the YAML lines.
 */
function replacementRow(indent) {
  const pad = count => ' '.repeat(count)
  return [
    `${pad(indent)}- id: tool-fs-encoded-source`,
    `${pad(indent + 2)}name: '@deepseek-ai/dsh-tool-fs-encoded-source'`,
    `${pad(indent + 2)}config:`,
    `${pad(indent + 4)}sampleOverCapGlobResults: false`,
    `${pad(indent + 4)}fallback:`,
    `${pad(indent + 6)}- encoding: gb18030`,
    `${pad(indent + 8)}extensions:`,
    `${pad(indent + 10)}- .cls`,
    `${pad(indent + 10)}- .bas`,
    `${pad(indent + 10)}- .frm`,
    `${pad(indent + 10)}- .ctl`,
    `${pad(indent + 10)}- .pag`,
    `${pad(indent + 10)}- .vbp`,
    `${pad(indent + 10)}- .cs`,
    `${pad(indent + 10)}- .csproj`,
  ]
}

/**
 * Leading spaces of one line.
 * @param {string} line - the line to measure.
 * @returns {number} the indentation width.
 */
function indentationOf(line) {
  let index = 0
  while (line[index] === ' ') index += 1
  return index
}

/**
 * Remove a fixed prefix of spaces from one line.
 * @param {string} line - the source line.
 * @param {number} count - spaces to remove.
 * @returns {string} the dedented line.
 */
function dedent(line, count) {
  let index = 0
  while (index < count && line[index] === ' ') index += 1
  return line.slice(index)
}

/**
 * Read one shipped preset patch and return the preset row's `config:` body.
 * @param {string} presetDir - the `@deepseek-ai/dsh-web-app` package directory.
 * @param {string} preset - the preset id.
 * @returns {{name: string, body: string[]}} the row's module name and dedented config body.
 */
function readPresetConfig(presetDir, preset) {
  const source = readFileSync(join(presetDir, 'presets', `${preset}.patch.yml`), 'utf8')
  const lines = source.split('\n')
  const nameAt = lines.findIndex(line => line.trimStart().startsWith(`- id: preset-${preset}`))
  if (nameAt < 0) throw new Error(`preset ${preset} is not declared in ${presetDir}`)
  const nameLine = lines[nameAt + 1]
  const name = /name:\s*'?([^'\n]+)'?/u.exec(nameLine)?.[1]
  if (name === undefined) throw new Error(`preset ${preset} declares no module name`)
  const configAt = lines.findIndex((line, index) => index > nameAt && line.trim() === 'config:')
  if (configAt < 0) throw new Error(`preset ${preset} declares no config`)
  const body = []
  for (const line of lines.slice(configAt + 1)) {
    if (line.trim().length === 0) {
      body.push('')
      continue
    }
    body.push(dedent(line, CONFIG_INDENT))
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop()
  return { name, body }
}

/**
 * Rewrite the two tool rows of one preset config body.
 * @param {string[]} body - the dedented config body.
 * @returns {string[]} the rewritten body.
 */
function rewriteTools(body) {
  const out = []
  for (let index = 0; index < body.length; index++) {
    const line = body[index]
    const indent = indentationOf(line)
    const pad = count => ' '.repeat(count)
    out.push(line)
    if (line.trim() === "- id: tool-fs") {
      const nameLine = body[index + 1]
      if (!nameLine?.includes("name: '@deepseek-ai/dsh-tool-fs'")) {
        throw new Error('the tool-fs row does not name @deepseek-ai/dsh-tool-fs')
      }
      out.push(nameLine, `${pad(indent + 2)}config:`, `${pad(indent + 4)}read: false`)
      index += 1
      continue
    }
    if (line.trim() === '- id: tool-fs-search') {
      const nameLine = body[index + 1]
      if (!nameLine?.includes("name: '@deepseek-ai/dsh-tool-fs-search'")) {
        throw new Error('the tool-fs-search row does not name @deepseek-ai/dsh-tool-fs-search')
      }
      out.push(nameLine)
      // Keep the row's own config, disable it, and add the replacement below.
      let cursor = index + 2
      while (cursor < body.length && body[cursor].trim().length > 0 && indentationOf(body[cursor]) > indent) {
        out.push(body[cursor])
        cursor += 1
      }
      out.push(`${pad(indent + 2)}disabled: true`, ...replacementRow(indent))
      index = cursor - 1
      continue
    }
  }
  return out
}

/**
 * Build the patch document for the configured presets.
 * @param {string} presetDir - the `@deepseek-ai/dsh-web-app` package directory.
 * @returns {string} the YAML document.
 */
function buildPatch(presetDir) {
  const header = [
    '# Agent-preset layer of the encoded-source bundle.',
    '#',
    '# A Web profile keeps its agent tool rows inside the preset rows, where the',
    '# Loader patch composer cannot address them by id; the only reachable edit is',
    '# replacing each preset row config. Generated from the shipped presets by',
    '# prepare-presets-patch.mjs -- regenerate it when those presets change.',
  ]
  const rows = []
  for (const preset of PRESETS) {
    const { name, body } = readPresetConfig(presetDir, preset)
    rows.push(`- id: preset-${preset}`, `  name: '${name}'`, '  config:', ...rewriteTools(body))
  }
  return `${[...header, ...rows].join('\n')}\n`
}

const [presetDir, output] = process.argv.slice(2)
if (presetDir === undefined) {
  console.error('usage: node prepare-presets-patch.mjs <dsh-web-app package dir> [output path]')
  process.exit(2)
}
const target = resolve(output ?? join(import.meta.dirname, 'presets.patch.yml'))
writeFileSync(target, buildPatch(resolve(presetDir)))
console.log(`wrote ${target}`)
