# C1–C25 开发记录（第三轮）：R4 有效写入与凭据状态

开发日期：2026-11-17（Asia/Shanghai）。范围：继续 [C1–C25 验收](C1_C25_ACCEPTANCE.md) 的 R4，本轮完成 R4.1（写入后在运行时真正生效的层并复查有效值）与 R4.4（可选 key 与 setupStatus 分离），并改进 R4.5 的部分保存报告；R4.2（mock 网关整链）与 R4.3（占位模型阻断推理）未完成。R2.1/R2.2/R2.4/R2.6 仍缺，见[第二轮记录](C1_C25_DEVELOPMENT_ROUND2.md)。

## 结论

`DSH: Configure Company Endpoint` 与 Models 页保存模型不再对“写了全局值但运行时仍读 workspace 旧值”的情况回 `ok: true`：写入落在决定有效值的那一层，写后重读校验，folder 层覆盖则明确拒绝并保留草稿。setupStatus 不再把可选 key 当作缺失字段，而是单独报告“未存”，鉴权要求是否成立标记为未检查。

## R4.1：写入生效层并复查

新增 [configuration.ts](../../apps/vscode/src/host/configuration.ts)：`writeEffectiveSetting(key, value)` 先 `inspect` 该设置的 global/workspace/folder 层，再决定写入目标。

| 情况 | 行为 |
| --- | --- |
| 无覆盖 | 写 Global |
| workspace 覆盖 | 写 Workspace 层（全局写会被覆盖），返回 `overridden: ['workspace']` |
| workspace folder 覆盖 | 拒绝并提示用户在该文件夹设置里修改；不写、不存 key、不重启 |
| 写入被其它层压过 | 写后 `get` 复查，值不一致即报错，不再回成功 |
| 更新本身失败 | 错误原样抛给命令，命令按“保存失败”报告 |

接入点：[extension.ts](../../apps/vscode/src/extension.ts) 的 `writeCompanySettings` 与 [chat-view.ts](../../apps/vscode/src/view/chat-view.ts) 的 `answerSetProviderModel`。端点先写、模式后写；模式写失败时报“端点已保存，但 provider mode 未保存”，不笼统说整体失败（R4.5 部分）。

回归用例：[configuration.spec.ts](../../apps/vscode/tests/configuration.spec.ts) 覆盖 Global/Workspace/folder 三种层、写后读回不一致、更新抛错；[company-setup.spec.ts](../../apps/vscode/tests/company-setup.spec.ts) 新增“workspace 覆盖写到 Workspace 层”和“folder 覆盖被拒且不存 key、不重启”，原有全局写入用例保持通过。

## R4.4：可选 key 不再算作 setup 不完整

[settings.ts](../../apps/vscode/src/host/settings.ts) 的 `CompanySetupStatus` 改为：`missing` 只含 endpoint 与 model；新增 `credential: 'stored' | 'not-stored'`；`complete` 不再受 key 影响。

[extension.ts](../../apps/vscode/src/extension.ts) 的启动检查在设置完整但未存 key 时记一条日志：未存 key，且“端点是否要求鉴权未检查”。这样公司网关若允许匿名调用可直接用，若要求鉴权则由发现/请求的 401 说话，而不是在启动前把它误报成配置缺失。

回归用例：[settings.spec.ts](../../apps/vscode/tests/settings.spec.ts) 更新为新的三段状态，并新增“未存 key 但路由完整”。

## 实际运行的检查

| 命令 | 结果 |
| --- | --- |
| `vitest ... configuration/company-setup/settings/chat-view` | 4 文件、39 测试通过，exit 0 |
| 全量 `vitest`（apps/vscode） | 28 文件、266 测试通过，exit 0 |
| `tsc -p tsconfig.json --noEmit`（apps/vscode） | exit 0 |

## 仍未验证

- R4.2：还没有一条 mock 公司网关把“配置→发现→候选→选择→有效值→overlay→重启”串成一个测试；当前是分层用例拼起来的证据。
- R4.3：`UNCONFIGURED_MODEL_ID` 仍只靠注释与保存校验；正式推理提交门禁与“先获取并选择模型”的入口未实现，占位模型仍可能被发到真实网关。
- R4.5：URL 切换后重新发现、key 保存失败的完整报告、capacity 保持部署声明已有行为但未新增针对性用例。
- R1、R3、R8 未开始；R2.1/R2.2/R2.4/R2.6 未完成；真实 GUI、候选 VSIX、真实公司网关仍未验证；C9/C10 维持暂缓。
