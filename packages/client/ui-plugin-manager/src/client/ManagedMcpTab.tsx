/** VS Code's profile-owned MCP tab. */
import { useEffect, useState, type FormEvent } from 'react'
import {
  Button, IconChevronDownOutlineRegular, IconDownloadOutlineRegular, IconFolderOpenOutlineRegular,
  IconPlusOutlineRegular, Menu, MenuItemButton, Switch,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './PluginManagerPage.module.css'
import styles from './ManagedMcpTab.module.css'
import type { ManagedMcpKey } from './locales/managed-mcp.ts'

interface Server {
  readonly name: string
  readonly enabled: boolean
  readonly transport: 'stdio' | 'streamable-http'
  readonly command?: string
  readonly cwd?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly missing?: readonly string[]
  readonly tools?: readonly { name: string; description: string }[]
}
interface Snapshot { readonly pending: boolean; readonly servers: readonly Server[]; readonly external: readonly string[] }
type Page = { kind: 'list' | 'import' } | { kind: 'edit'; server: Server; original?: string } | { kind: 'detail'; name: string }

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function parseValueMap(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (!object(value) || !Object.values(value).every(item => typeof item === 'string')) throw new Error('invalid-import')
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]))
}

/**
 * Normalize the documented JSON containers without executing their commands.
 * @param source JSON text.
 * @returns Inactive, typed definitions for review and server-side validation.
 */
export function previewManagedMcp(source: string): Server[] {
  const value: unknown = JSON.parse(source)
  const entries = object(value) ? value.mcpServers ?? value.servers : undefined
  if (!object(entries)) throw new Error('invalid-import')
  return Object.entries(entries).map(([name, row]) => {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name) || !object(row)) throw new Error('invalid-import')
    const enabled = false
    if (typeof row.command === 'string' && row.command.trim() && row.url === undefined && (row.type === undefined || row.type === 'stdio')) {
      const args = row.args ?? []
      if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) throw new Error('invalid-import')
      if (row.cwd !== undefined && typeof row.cwd !== 'string') throw new Error('invalid-import')
      return { name, enabled, transport: 'stdio', command: row.command, args, ...(row.cwd === undefined ? {} : { cwd: row.cwd }), env: parseValueMap(row.env) }
    }
    if (typeof row.url === 'string' && row.command === undefined && (row.type === undefined || row.type === 'http' || row.type === 'streamable-http')) {
      const url = URL.parse(row.url)
      if (url !== null && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
        return { name, enabled, transport: 'streamable-http', url: row.url, headers: parseValueMap(row.headers) }
      }
    }
    throw new Error('invalid-import')
  })
}

const exampleEnv = {
  ORACLE_MCP_CONNECT_STRING: '${env:ORACLE_TRAINING_CONNECT_STRING}',
  ORACLE_MCP_USERNAME: '${env:ORACLE_TRAINING_USERNAME}',
  ORACLE_MCP_PASSWORD: '${env:ORACLE_TRAINING_PASSWORD}',
  ORACLE_MCP_DEPLOYMENT_TIER: 'TRAINING',
  ORACLE_MCP_ENVIRONMENT: 'ORACLE-TRAINING',
}
const oraclePath = 'C:\\CompanyTools\\Oracle'
const localExample: Server = { name: 'oracle-training', enabled: false, transport: 'stdio',
  command: oraclePath + '\\oracle-readonly-mcp.exe', cwd: oraclePath, env: exampleEnv }
const remoteExample: Server = { name: 'company-docs', enabled: false, transport: 'streamable-http', url: 'https://docs.example.invalid/mcp' }
const sampleConfig = JSON.stringify({ mcpServers: {
  'oracle-training': { command: localExample.command, cwd: oraclePath, env: exampleEnv },
  'oracle-training-b': { command: localExample.command, cwd: oraclePath, env: {
    ...exampleEnv,
    ORACLE_MCP_CONNECT_STRING: '${env:ORACLE_TRAINING_B_CONNECT_STRING}',
    ORACLE_MCP_USERNAME: '${env:ORACLE_TRAINING_B_USERNAME}',
    ORACLE_MCP_PASSWORD: '${env:ORACLE_TRAINING_B_PASSWORD}',
    ORACLE_MCP_ENVIRONMENT: 'ORACLE-TRAINING-B',
  } },
} }, null, 2)

async function request(payload?: object, signal?: AbortSignal): Promise<Snapshot> {
  const response = await fetch('/api/vscode.mcp', payload === undefined ? signal === undefined ? undefined : { signal } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const result: unknown = await response.json()
    throw new Error(object(result) && typeof result.error === 'string' ? result.error : 'request-failed')
  }
  return await response.json() as Snapshot
}

function parseLines(value: string): Record<string, string> {
  return Object.fromEntries(value.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const split = line.indexOf('=')
    if (split < 1) throw new Error('invalid-settings')
    return [line.slice(0, split).trim(), line.slice(split + 1)]
  }))
}

type TabProps = PropsLocale<'plugins.managedMcp'>

/**
 * Manage the current VS Code profile's MCP connections.
 * @param props Slot-owned locale dictionary.
 * @returns The MCP list, add forms, import review or tool details.
 */
export function ManagedMcpTab({ t }: TabProps) {
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [page, setPage] = useState<Page>({ kind: 'list' })
  const [menu, setMenu] = useState(false)
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState<ManagedMcpKey>()
  const [busy, setBusy] = useState(false)
  const [raw, setRaw] = useState('')
  const [preview, setPreview] = useState<Server[]>([])
  const [example, setExample] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [formRevision, setFormRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void request(undefined, controller.signal).then(setSnapshot, () => {
      if (!controller.signal.aborted) setNotice('failed')
    })
    return () => { controller.abort() }
  }, [])
  const errorKey = (error: unknown): ManagedMcpKey => {
    const reason = error instanceof Error ? error.message : ''
    if (reason === 'duplicate-server') return 'duplicate'
    if (reason === 'missing-credentials') return 'credentials'
    if (reason === 'credential-reference-required') return 'reference'
    return reason.startsWith('invalid-') ? 'badConfig' : 'failed'
  }
  const navigate = (next: Page) => { setNotice(undefined); setMenu(false); setRemoving(false); setExample(false); setPage(next) }
  const run = async (payload?: object, next?: Page) => {
    setBusy(true)
    setNotice(undefined)
    try {
      setSnapshot(await request(payload))
      if (next !== undefined) navigate(next)
    } catch (error) { setNotice(errorKey(error)) }
    finally { setBusy(false) }
  }
  const showPreview = (text: string) => {
    setRaw(text)
    setNotice(undefined)
    try {
      const entries = previewManagedMcp(text)
      const names = new Set([...(snapshot?.external ?? []), ...(snapshot?.servers.map(server => server.name) ?? [])])
      if (entries.some(server => names.has(server.name))) { setPreview([]); setNotice('duplicate'); return }
      setPreview(entries)
      if (entries.length === 0) setNotice('noPreview')
    } catch { setPreview([]); setNotice('invalidJson') }
  }
  const readImportFile = (file: File | undefined) => {
    if (file === undefined) return
    if (file.size > 1024 * 1024) { setPreview([]); setNotice('invalidJson'); return }
    void file.text().then(showPreview, () => { setPreview([]); setNotice('invalidJson') })
  }
  const openImport = () => { setRaw(''); setPreview([]); navigate({ kind: 'import' }) }
  const openForm = (transport: Server['transport']) => navigate({ kind: 'edit', server: { name: '', enabled: false, transport } })
  const submit = (event: FormEvent<HTMLFormElement>, current: Extract<Page, { kind: 'edit' }>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const value = (key: string) => String(data.get(key) ?? '').trim()
    const name = value('name')
    try {
      const server: Server = current.server.transport === 'stdio'
        ? { name, enabled: false, transport: 'stdio', command: value('command'), cwd: value('cwd'), args: value('args').split(/\r?\n/).filter(Boolean), env: parseLines(value('values')) }
        : { name, enabled: false, transport: 'streamable-http', url: value('url'), headers: parseLines(value('values')) }
      void run({ action: current.original === undefined ? 'add' : 'edit', original: current.original, servers: [server] }, { kind: 'detail', name })
    } catch { setNotice('badConfig') }
  }
  const restart = async () => {
    const carrier = (globalThis as { __DSH_TRANSPORT__?: { restartHost?: () => Promise<void> } }).__DSH_TRANSPORT__
    if (carrier?.restartHost === undefined) { setNotice('failed'); return }
    setBusy(true)
    try { await carrier.restartHost(); await run() }
    catch { setNotice('failed') }
    finally { setBusy(false) }
  }
  const selected = page.kind === 'detail' ? snapshot?.servers.find(server => server.name === page.name) : undefined
  const matches = (name: string) => name.toLowerCase().includes(query.toLowerCase())
  return <div className={styles.page} aria-busy={busy}>
    {snapshot?.pending && <div className={styles.notice}><span>{t('pending')}</span><Button disabled={busy} size="sm" onClick={() => { void restart() }}>{t('restart')}</Button></div>}
    {notice && <div className={styles.notice} role="status"><span>{t(notice)}</span>{snapshot === undefined && <Button size="sm" onClick={() => { void run() }}>{t('retry')}</Button>}</div>}
    {page.kind !== 'list' && <Button size="sm" disabled={busy} onClick={() => { navigate({ kind: 'list' }) }}>{t('back')}</Button>}
    {page.kind === 'list' && <>
      <div className={styles.toolbar}>
        <input className={styles.field} type="search" aria-label={t('search')} placeholder={t('search')} value={query} onChange={event => { setQuery(event.currentTarget.value) }} />
        <span className={css.addGroup}>
          <Button className={css.addPrimary} icon={<IconPlusOutlineRegular size={13} />} variant="primary" size="sm" onClick={openImport}>{t('import')}</Button>
          <Menu open={menu} onClose={() => { setMenu(false) }} align="end" portal autoFocus listClassName={css.addMenu} anchor={
            <Button className={css.addMore} aria-label={t('other')} aria-haspopup="menu" aria-expanded={menu} variant="primary" size="sm" onClick={() => { setMenu(!menu) }}>
              <IconChevronDownOutlineRegular size={12} aria-hidden="true" />
            </Button>
          }>
            <MenuItemButton icon={<IconFolderOpenOutlineRegular size={14} />} onSelect={() => { openForm('stdio') }}>
              <span className={css.addMenuItem}><span>{t('local')}</span><span className={css.addMenuDescription}>{t('localHint')}</span></span>
            </MenuItemButton>
            <MenuItemButton icon={<IconDownloadOutlineRegular size={14} />} onSelect={() => { openForm('streamable-http') }}>
              <span className={css.addMenuItem}><span>{t('remote')}</span><span className={css.addMenuDescription}>{t('remoteHint')}</span></span>
            </MenuItemButton>
          </Menu>
        </span>
      </div>
      <p>{t('intro')}</p>
      {snapshot === undefined && !notice && <p role="status">{t('loading')}</p>}
      {snapshot !== undefined && snapshot.servers.filter(server => matches(server.name)).map(server => <div className={styles.row} key={server.name}>
        <Button size="sm" onClick={() => { navigate({ kind: 'detail', name: server.name }) }}>{server.name}</Button>
        <span>{t(server.transport === 'stdio' ? 'local' : 'remote')}</span>
        <Switch checked={server.enabled} disabled={busy} label={server.name} onChange={enabled => { void run({ action: 'toggle', name: server.name, enabled }) }} />
      </div>)}
      {snapshot !== undefined && !snapshot.servers.some(server => matches(server.name)) && !snapshot.external.some(matches) && <p>{t('empty')}</p>}
      {snapshot !== undefined && snapshot.external.some(matches) && <section><h3>{t('external')}</h3><p>{t('externalHint')}</p>
        <ul>{snapshot.external.filter(matches).map(name => <li key={name}>{name}</li>)}</ul>
      </section>}
    </>}
    {page.kind === 'import' && <>
      <h2>{t('import')}</h2><p>{t('importHint')}</p>
      <label className={styles.filePicker} onDragOver={event => { event.preventDefault() }} onDrop={event => {
        event.preventDefault()
        if (!busy) readImportFile(event.dataTransfer.files[0])
      }}>{t('selectJson')}<input type="file" accept=".json,application/json" disabled={busy}
        onChange={event => { readImportFile(event.currentTarget.files?.[0]) }} /></label>
      <label>{t('paste')}<textarea className={styles.field} rows={7} value={raw} disabled={busy} onChange={event => { setRaw(event.currentTarget.value); setPreview([]) }} /></label>
      <div className={styles.actions}><Button disabled={busy} onClick={() => { showPreview(sampleConfig) }}>{t('sampleJson')}</Button>
        <Button disabled={busy} variant="primary" onClick={() => { showPreview(raw) }}>{t('preview')}</Button></div>
      {preview.length > 0 && <section className={styles.review}>
        <ul>{preview.map(server => <li key={server.name}><strong>{server.name}</strong> <code>{server.command ?? server.url}</code></li>)}</ul>
        <Button disabled={busy} variant="primary" onClick={() => { void run({ action: 'add', servers: preview }, { kind: 'list' }) }}>{t('importDisabled')}</Button>
      </section>}
    </>}
    {page.kind === 'edit' && <>
      <div className={styles.toolbar}><h2>{t(page.server.transport === 'stdio' ? 'local' : 'remote')}</h2>
        <Button size="sm" disabled={busy} onClick={() => { setExample(true); setFormRevision(formRevision + 1); setPage({ ...page, server: page.server.transport === 'stdio' ? localExample : remoteExample }) }}>{t('sample')}</Button></div>
      <p>{t(page.server.transport === 'stdio' ? 'localHelp' : 'remoteHelp')}</p>
      {example && <p role="status">{t('exampleApplied')}</p>}
      <form key={formRevision} className={styles.form} onSubmit={event => { submit(event, page) }}>
        <label>{t('name')}<input className={styles.field} name="name" required pattern="[A-Za-z0-9_-]{1,32}" defaultValue={page.server.name}/><small>{t('nameHint')}</small></label>
        {page.server.transport === 'stdio' ? <>
          <label>{t('command')}<input className={styles.field} name="command" required defaultValue={page.server.command} placeholder={localExample.command}/></label>
          <label>{t('args')}<textarea className={styles.field} name="args" rows={2} defaultValue={page.server.args?.join('\n')}/></label>
          <label>{t('cwd')}<input className={styles.field} name="cwd" defaultValue={page.server.cwd} placeholder={oraclePath}/></label>
        </> : <label>{t('url')}<input className={styles.field} name="url" type="url" required defaultValue={page.server.url} placeholder={remoteExample.url}/></label>}
        <label>{t(page.server.transport === 'stdio' ? 'env' : 'headers')}<textarea className={styles.field} name="values" rows={4} defaultValue={Object.entries(page.server.env ?? page.server.headers ?? {}).map(([key, value]) => key + '=' + value).join('\n')}/><small>{t('valueHint')}</small></label>
        <div className={styles.actions}><Button variant="primary" disabled={busy} type="submit">{t('save')}</Button></div>
      </form>
    </>}
    {selected && <>
      <div className={styles.toolbar}><h2>{selected.name}</h2>
        <Button size="sm" disabled={busy} onClick={() => { navigate({ kind: 'edit', server: selected, original: selected.name }) }}>{t('edit')}</Button>
        <Switch checked={selected.enabled} disabled={busy} label={t('status')} onChange={enabled => { void run({ action: 'toggle', name: selected.name, enabled }) }} />
      </div>
      {selected.missing?.length ? <p>{t('credentials')} <code>{selected.missing.join(', ')}</code></p> : null}
      <section className={styles.review}>
        <div className={styles.toolbar}><h3>{t('tools')}</h3><Button size="sm" disabled={busy} onClick={() => { void run() }}>{t('check')}</Button></div>
        {selected.tools?.length ? <><dl>{selected.tools.map(tool => <div key={tool.name}><dt>{tool.name}</dt><dd>{tool.description}</dd></div>)}</dl><p>{t('toolHelp')}</p></> : <p>{t(selected.enabled ? 'noTools' : 'disabledHint')}</p>}
      </section>
      <div className={styles.actions}>{removing ? <>
        <Button disabled={busy} onClick={() => { setRemoving(false) }}>{t('cancel')}</Button>
        <Button disabled={busy} onClick={() => { void run({ action: 'remove', name: selected.name }, { kind: 'list' }) }}>{t('confirmRemove')}</Button>
      </> : <Button disabled={busy} onClick={() => { setRemoving(true) }}>{t('remove')}</Button>}</div>
    </>}
  </div>
}
