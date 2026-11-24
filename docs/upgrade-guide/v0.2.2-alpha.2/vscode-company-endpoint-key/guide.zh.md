---
kind: upgrade-guide
description: VS Code 扩展要求重新输入此前未绑定端点 URL 的公司 API 密钥。
---

# VS Code 按端点 URL 使用公司 API 密钥

[English](guide.md) | 中文

## 变更

VS Code 扩展 `0.1.0` 版按端点 URL 从 VS Code SecretStorage 读取公司 API 密钥。`0.0.0` 版保存的公司密钥没有绑定端点。旧密钥仍保存在 SecretStorage 中，供回退使用。

## 迁移

1. 在 VS Code 中打开 DSH 视图。确认 `dsh.llmBaseUrl` 指向签发密钥的公司端点。
2. 运行 `DSH: Set Private Endpoint API Key` 并输入该 URL 的密钥。等待正在运行的工作完成后重启。
3. 运行 `DSH: Select Company Model`，确认公司端点返回模型列表。
