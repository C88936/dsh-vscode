const { readFileSync, readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')
const files = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const s = statSync(p)
    if (s.isDirectory()) { walk(p); continue }
    files.push(p)
  }
}
walk('apps/vscode/src')
files.push('apps/vscode/package.json', 'apps/vscode/profile/vscode.patch.yml')
const bad = files.filter(f => readFileSync(f, 'utf8').includes('\uFFFD'))
console.log(bad.length === 0 ? 'all valid UTF-8: ' + files.length + ' files' : 'mojibake: ' + bad.join(', '))
