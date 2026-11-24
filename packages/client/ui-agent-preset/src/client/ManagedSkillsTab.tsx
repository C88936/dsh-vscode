/** Workspace, personal and bundled Skills exposed in the VS Code Plugins page. */
import { useEffect, useState } from 'react'
import { Button, IconPlusOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import styles from './ManagedSkillsTab.module.css'

interface Skill {
  readonly name: string
  readonly description: string
  readonly source: string
  readonly path?: string
  readonly content?: string
}
type Scope = 'project' | 'personal' | 'system'
function sourceGroup(source: string): Scope {
  if (source.startsWith('project-')) return 'project'
  if (source.startsWith('user-') || source === 'custom') return 'personal'
  return 'system'
}

type Props = PropsLocale<'plugins.managedSkills'> & PropsRuntime<'plugins.tab'> & InjectFace<{
  start: (name: string, workspaceId: Parameters<UiWorkspace['startSession']>[0]) => void
}>

/**
 * Display the live Host skill catalog and route invocation into the normal conversation.
 * @param props Locale, workspace scope and conversation navigation supplied by the slot.
 * @returns The categorized Skill list or one Skill's instructions.
 */
export function ManagedSkillsTab({ t, start, useWorkspaces }: Props) {
  const workspaces = useWorkspaces(snapshot => snapshot.items)
  const [workspacePath, setWorkspacePath] = useState('')
  const workspace = workspaces.find(item => item.path === workspacePath) ?? workspaces[0]
  const cwd = workspace?.path ?? ''
  const [scope, setScope] = useState<Scope | 'all'>('all')
  const [query, setQuery] = useState('')
  const [skills, setSkills] = useState<readonly Skill[]>()
  const [detail, setDetail] = useState<Skill>()
  const [error, setError] = useState<'failed' | 'openFailed'>()
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    const url = '/api/vscode.skills?' + new URLSearchParams({ cwd })
    void fetch(url, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('skill-catalog')
      const items = await response.json() as Skill[]
      if (!controller.signal.aborted) setSkills(items)
    }).catch(() => { if (!controller.signal.aborted) setError('failed') })
    return () => { controller.abort() }
  }, [cwd, refresh])
  const show = async (name: string) => {
    setError(undefined)
    try {
      const response = await fetch('/api/vscode.skills?' + new URLSearchParams({ cwd, name }))
      if (!response.ok) throw new Error('skill-detail')
      setDetail(await response.json() as Skill)
    } catch { setError('failed') }
  }
  const open = async (path: string) => {
    const carrier = (globalThis as { __DSH_TRANSPORT__?: { openResource?: (request: { address: string; path: string }) => Promise<{ ok: boolean }> } }).__DSH_TRANSPORT__
    try {
      const result = await carrier?.openResource?.({ address: path, path })
      if (result?.ok !== true) setError('openFailed')
    } catch { setError('openFailed') }
  }
  const matches = (skills ?? []).filter(skill => (scope === 'all' || sourceGroup(skill.source) === scope)
    && (skill.name + ' ' + skill.description).toLowerCase().includes(query.toLowerCase()))
  return <div className={styles.page}>
    {error && <p role="status">{t(error)}</p>}
    {detail !== undefined ? <>
      <Button size="sm" onClick={() => { setDetail(undefined); setError(undefined) }}>{t('back')}</Button>
      <h2>{detail.name}</h2><p>{t(sourceGroup(detail.source))} · {detail.description}</p>
      {detail.path && <code>{detail.path}</code>}
      <pre className={styles.preview}>{detail.content}</pre>
      <div className={styles.actions}>
        {detail.path && <Button onClick={() => { void open(detail.path!) }}>{t('open')}</Button>}
        <Button disabled={workspace === undefined} variant="primary" onClick={() => { start(detail.name, workspace?.workspaceId) }}>{t('use')}</Button>
      </div>
    </> : <>
      <div className={styles.bar}>
        <input className={styles.field} type="search" value={query} aria-label={t('search')} placeholder={t('search')} onChange={event => { setQuery(event.currentTarget.value) }} />
        <div className={styles.actions}>
          <Button size="sm" icon={<IconRefreshOutlineRegular size={13} />} onClick={() => { setError(undefined); setSkills(undefined); setRefresh(refresh + 1) }}>{t('refresh')}</Button>
          <Button size="sm" variant="primary" icon={<IconPlusOutlineRegular size={13} />} disabled={workspace === undefined}
            onClick={() => { start('skill-creator', workspace?.workspaceId) }}>{t('create')}</Button>
        </div>
      </div>
      <p>{t('intro')}</p>
      {workspaces.length > 0 && <label className={styles.workspace}>{t('workspace')}
        <select className={styles.field} value={cwd} onChange={event => {
          setWorkspacePath(event.currentTarget.value); setSkills(undefined); setError(undefined)
        }}>{workspaces.map(item => <option key={item.workspaceId} value={item.path}>{item.path}</option>)}</select>
      </label>}
      <div className={styles.actions} role="group" aria-label={t('tab')}>
        {(['all', 'project', 'personal', 'system'] as const).map(value =>
          <Button key={value} size="sm" aria-pressed={scope === value} variant={scope === value ? 'outline' : 'ghost'}
            onClick={() => { setScope(value) }}>{t(value)}</Button>)}
      </div>
      {skills === undefined && !error && <p role="status">{t('loading')}</p>}
      {skills !== undefined && matches.length === 0 && <p>{t('empty')}</p>}
      {(['project', 'personal', 'system'] as const).map(group => {
        const entries = matches.filter(item => sourceGroup(item.source) === group)
        return entries.length > 0 && <section key={group}><h3>{t(group)}</h3><div className={styles.grid}>
          {entries.map(item => <button key={item.name} type="button" className={styles.skill} onClick={() => { void show(item.name) }}>
            <strong>{item.name}</strong><span>{item.description}</span>
          </button>)}
        </div></section>
      })}
    </>}
  </div>
}
