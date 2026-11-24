# MCP 配置（0.2.3 起）

DSH 0.2.3 把 MCP 收敛到官方 `@deepseek-ai/dsh-mcp-manager`。它不再是一个独立页面，而是**设置项 + 宿主服务**：管理器按 `Config.servers` 挂载、探测并授权服务器，同时读取 profile 里已有的服务器条目。随产品分发的 `dsh-mcp-setup` skill（`profile/skills/dsh-mcp-setup/SKILL.md`）就是给助手用的配置流程。

## 方式 A：在界面里加（推荐给最终用户）

1. 打开设置页
2. 找到 MCP 管理器（`@deepseek-ai/dsh-mcp-manager`）的设置分组
3. 在 `servers` 里添加一条：

```json
{
  "name": "example",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@example/mcp-server"],
  "env": {}
}
```

远端服务把 `transport` 换成 `streamable-http`，用 `url` 和可选的 `headers` 代替 `command`/`args`。

## 方式 B：让助手配置（推荐给批量/复杂场景）

把服务商提供的 README、配置示例或 JSON 直接发给助手，说"照这个把这个 MCP 接进来"。助手会加载 `dsh-mcp-setup` skill：读供应商文档、确认可执行文件或 URL、在 profile 里写入条目、保留已有条目、把凭据留在受控来源、最后重载并验证工具注册。

## 方式 C：手工写 profile

在 profile 的 `cordis.patch.yml` 的 `insert` 下加一条：

```yaml
- insert:
    - id: mcp-example
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: example
        transport: stdio
        command: npx
        args: ['-y', '@example/mcp-server']
```

写完后重启 DSH 宿主（VS Code 里可用 `DSH: Restart Host`），再让助手列一次工具确认。

## 凭据

不要把 token、密码写进 `cordis.patch.yml` 或 `mcp-servers.json`。用环境变量、DSH 凭据存储，或供应商自己的登录流程；配置里只引用名字。

## 排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 工具列表里没有该服务器 | 条目被标记 `disabled: true`，或 `serverName` 重复 | 检查 profile，改唯一名字 |
| 启动即报错 | `command` 路径不存在或依赖没装 | 先手动跑一次该命令 |
| 远端 401/403 | 凭据缺失或过期 | 重新授权，别把 token 写进配置 |
| 改完没生效 | 宿主没重载 | `DSH: Restart Host` |

## 和旧的 MCP 页签的关系

旧版 VS Code 扩展在插件页有一个自研 MCP 页签，转发到扩展自己的 `/api/vscode.mcp` 路由。0.2.3 用官方管理器替换了那条路由，页签已删除；配置与授权统一走上面的三种方式。
