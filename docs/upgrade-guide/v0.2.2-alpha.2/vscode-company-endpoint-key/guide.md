---
kind: upgrade-guide
description: The VS Code extension requires a fresh entry for company API keys previously saved without an endpoint URL.
---

# Company API keys in VS Code use the endpoint URL

English | [中文](guide.zh.md)

## Change

VS Code extension version `0.1.0` looks up company API keys saved in VS Code SecretStorage by endpoint URL. Version `0.0.0` saved one company key without an endpoint association. The old value stays in SecretStorage for rollback.

## Migration

1. Open the DSH view in VS Code. Verify that `dsh.llmBaseUrl` names the company endpoint that issued your key.
2. Run `DSH: Set Private Endpoint API Key` and enter the key for that URL. Apply the guarded restart after any running work finishes.
3. Run `DSH: Select Company Model` and verify that the company endpoint returns its model list.
