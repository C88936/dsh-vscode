const en = {
  tab: 'Skills', create: 'New skill', search: 'Search skills', workspace: 'Workspace', all: 'All', project: 'Project',
  personal: 'Personal', system: 'System', refresh: 'Refresh', loading: 'Loading skills…', empty: 'No skills match this view.',
  failed: 'Could not read skills. Refresh to try again.', back: 'Back to skills', use: 'Use in a conversation',
  open: 'Open skill file', openFailed: 'Could not open the skill file.',
  intro: 'View discovered skills or open a new conversation with Skill Creator selected.',
} as const
const zh: Record<keyof typeof en, string> = {
  tab: '技能', create: '新建技能', search: '搜索技能', workspace: '工作区', all: '全部', project: '项目',
  personal: '个人', system: '系统', refresh: '刷新', loading: '正在读取技能…', empty: '没有匹配的技能。',
  failed: '无法读取技能，请刷新后重试。', back: '返回技能', use: '在对话中使用',
  open: '打开技能文件', openFailed: '无法打开技能文件。',
  intro: '查看 DSH 发现的技能，或打开预选了技能创建器的新对话。',
}
/** Dictionaries owned by the Skills tab. */
export const managedSkillDictionaries = { en, zh }
/** Keys owned by the Skills tab. */
export type ManagedSkillKey = keyof typeof en
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'plugins.managedSkills': ManagedSkillKey }
}
