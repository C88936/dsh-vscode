# C1–C25 开发记录（第四轮）：R2.1 离线状态拆分

开发日期：2026-11-17（Asia/Shanghai）。范围：继续 [C1–C25 验收](C1_C25_ACCEPTANCE.md) 的 R2，本轮完成 R2.1 的数据模型部分：把“记录与 lockfile 一致”与“目标 store 就绪”“模块可加载”拆成独立状态。R2.2（真实离线 store 闭环与 fixture）、R2.4（本地导入离线政策）、R2.6（hostProvided/peer 可满足性）仍未实施。前几轮见[第一轮](C1_C25_DEVELOPMENT_ROUND1.md)、[第二轮](C1_C25_DEVELOPMENT_ROUND2.md)、[第三轮](C1_C25_DEVELOPMENT_ROUND3.md)。

## 结论

`prepared.offline === 'proven'` 不再被当成“完整离线安装承诺”：它与 `prepared.store`、`prepared.loadable` 并列，后两者固定为 `unverified`，明确表示读取器既不检查目标 pnpm store，也不导入候选模块。这是状态拆分，不是能力增强——真正的 store 证明与模块加载验证属于 R2.2。

## 修改

| 文件 | 变化 |
| --- | --- |
| [types.ts](../../packages/boot/plugin-manager/src/types.ts) | `PreparedBundleClosure` 新增必填 `store: 'unverified'` 与 `loadable: 'unverified'`；`offline` 的 JSDoc 改为“元数据一致”，`fingerprint` 说明改为覆盖整个包 |
| [local-bundle.ts](../../packages/boot/plugin-manager/src/local-bundle.ts) | 两个构造点都写入这两个状态 |
| [README.md](../../packages/boot/plugin-manager/README.md) | 读取器段落说明三者含义，以及 proven 只代表元数据 |
| [manager-store.client.spec.ts](../../packages/client/ui-plugin-manager/tests/manager-store.client.spec.ts) | 客户端 `PROVEN_PREPARED` fixture 补上两个新字段（类型消费方，行为未变） |

回归用例：[local-bundle.spec.ts](../../packages/boot/plugin-manager/tests/local-bundle.spec.ts) 的 proven 用例现在同时断言 `store: 'unverified'`、`loadable: 'unverified'`，防止有人把元数据校验结果误当离线闭环或可加载证明。

## 实际运行的检查

| 命令 | 结果 |
| --- | --- |
| plugin-manager `local-bundle` + `manager` | 2 文件、219 测试通过，exit 0 |
| `tsc -p tsconfig.json --noEmit`（plugin-manager） | exit 0 |
| client `manager-store.client.spec.ts` | 164 测试通过，exit 0 |

## 仍未验证

- R2.2：带锁定记录与完整物料的离线交付、目标 store 预检、空 store/无网络/仓库外 profile 的真实 fixture 都未做；`store` 仍只能是 `unverified`。
- R2.4：VS Code 本地导入的离线政策未实现；未证明完整的本地包仍可能走到默认公网 registry。
- R2.6：hostProvided/peer 的实际可满足性检查未补。
- 客户端界面尚未展示 `store`/`loadable` 两个状态（仅数据模型与文档），要展示需走 locale 文案与快照。
- 本轮未跑页面截图、真实 GUI、候选 VSIX；R1、R3、R4.2/R4.3、R8 仍未完成；C9/C10 维持暂缓。
