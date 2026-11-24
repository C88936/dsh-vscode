const en = {
  title: 'MCP', search: 'Search MCP servers', import: 'Import MCP configuration', other: 'Other MCP setup methods',
  local: 'Add a local program', localHint: 'Use an EXE or launch command, such as Oracle read-only queries.',
  remote: 'Connect a remote service', remoteHint: 'Use the MCP address for a service, such as company documentation.',
  intro: 'Choose Import if you already have JSON. Use the arrow for a program or a URL.',
  importHint: 'Select or paste JSON with mcpServers or servers. Install any required local program first.',
  selectJson: 'Choose JSON file', paste: 'Paste JSON', preview: 'Preview connections', sampleJson: 'Fill Oracle batch example',
  importDisabled: 'Import as disabled', noPreview: 'No connections to import.', duplicate: 'A server with that name already exists.',
  invalidJson: 'Enter valid JSON with a supported server entry and either a command or a URL.',
  back: 'Back to MCP', name: 'Server name', nameHint: '1–32 letters, digits, underscores or hyphens.',
  command: 'Command or EXE path', cwd: 'Working directory', args: 'Arguments, one per line',
  env: 'Environment variables', headers: 'Request headers', valueHint: 'Use NAME=value per line. For credentials, use ${env:VARIABLE} and set it in the VS Code launch environment.',
  localHelp: 'Install the program first. DSH starts it when you enable the connection and restart.',
  remoteHelp: 'Use the Streamable HTTP address given by the service owner.',
  url: 'Server URL', sample: 'Fill example', exampleApplied: 'Example filled in. Replace the values with your actual settings before saving.',
  save: 'Save as disabled', edit: 'Edit configuration', check: 'Refresh tools', remove: 'Remove connection',
  confirmRemove: 'Confirm removal', cancel: 'Cancel', empty: 'No MCP servers found.', loading: 'Loading…',
  enabled: 'Enabled', disabled: 'Disabled', external: 'From profile configuration',
  externalHint: 'Edit these connections in their original Cordis configuration.',
  pending: 'The saved changes will take effect after restarting DSH.', restart: 'Restart DSH',
  tools: 'Discovered tools', noTools: 'No tools discovered. Check the server configuration and whether it is running.',
  disabledHint: 'Enable the connection and restart DSH to discover its tools.',
  toolHelp: 'In a conversation, name the server and ask DSH to use its tool.',
  failed: 'Could not read or change MCP configuration. Try again.', badConfig: 'Check the server name, command, address and settings.',
  credentials: 'Provide the missing environment variables before enabling.', reference: 'Use an environment reference for passwords and tokens.',
  retry: 'Retry', status: 'Server status',
} as const
const zh: Record<keyof typeof en, string> = {
  title: 'MCP', search: '搜索 MCP 服务器', import: '导入 MCP 配置', other: '其他 MCP 添加方式',
  local: '添加本地程序', localHint: '手里有 EXE 或启动命令，例如 Oracle 只读查询。',
  remote: '连接远程服务', remoteHint: '手里有 MCP 地址，例如公司文档服务。',
  intro: '已有 JSON 就直接导入。有程序或地址时，点击箭头选择。',
  importHint: '选择或粘贴含 mcpServers 或 servers 的 JSON。若配置引用了本地程序，请先部署该程序。',
  selectJson: '选择 JSON 文件', paste: '粘贴 JSON', preview: '预览连接', sampleJson: '填入 Oracle 批量配置示例',
  importDisabled: '导入为停用', noPreview: '没有可导入的连接。', duplicate: '已存在同名服务器。',
  invalidJson: '请提供有效 JSON，并为每条连接填写启动命令或 URL。',
  back: '返回 MCP', name: '服务器名称', nameHint: '使用 1–32 个字母、数字、下划线或连字符。',
  command: '启动命令或 EXE 路径', cwd: '工作目录', args: '参数，每行一个',
  env: '环境变量', headers: '请求头', valueHint: '每行填写 名称=值。密码和令牌用 ${env:变量名} 引用，并从 VS Code 启动环境提供。',
  localHelp: '先部署程序。启用连接并重启 DSH 后，DSH 会在本机启动它。',
  remoteHelp: '填写服务方提供的 Streamable HTTP 地址。',
  url: '服务器 URL', sample: '填入示例', exampleApplied: '已填入示例，保存前请换成实际配置。',
  save: '保存为停用', edit: '编辑配置', check: '刷新工具', remove: '移除连接',
  confirmRemove: '确认移除', cancel: '取消', empty: '没有找到 MCP 服务器。', loading: '正在读取…',
  enabled: '已启用', disabled: '已停用', external: '来自原有配置',
  externalHint: '在原 Cordis 配置中修改这些连接。',
  pending: '更改已保存，重启 DSH 后生效。', restart: '重启 DSH',
  tools: '已发现的工具', noTools: '尚未发现工具。请检查服务器配置和运行状态。',
  disabledHint: '启用连接并重启 DSH 后，才能发现工具。',
  toolHelp: '在对话里说明要用哪台服务器和哪个工具。',
  failed: '无法读取或修改 MCP 配置，请重试。', badConfig: '请检查服务器名称、启动命令、地址和配置。',
  credentials: '请补齐所需环境变量后再启用。', reference: '密码和令牌请使用环境变量引用。',
  retry: '重试', status: '服务器状态',
}

/** Locale keys for the profile's MCP tab. */
export type ManagedMcpKey = keyof typeof en
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'plugins.managedMcp': ManagedMcpKey }
}
/** Locale dictionaries for the VS Code MCP tab. */
export const managedMcpDictionaries = { en, zh }
