# Changelog

All notable changes to this project will be documented in this file. See
[Conventional Commits](https://www.conventionalcommits.org/) for commit guidelines and
[release-please](https://github.com/googleapis/release-please) for how this file is generated.

## 1.0.0 (2026-04-18)


### Features

* accept _meta.systemPrompt on new/fork session ([8f1f6ad](https://github.com/khongtrunght/codex-acp/commit/8f1f6ad2b307c638638e7d462d7c2238af2b2ae5))
* add audio fallback mapping and extension-path tests ([0826f2e](https://github.com/khongtrunght/codex-acp/commit/0826f2e7ad4521cdad79061fd405840720b90aaf))
* add CLI help and version flags for bridge entrypoint ([0eaed04](https://github.com/khongtrunght/codex-acp/commit/0eaed04ecdcdb29d2f3ed4d5c7a50791faa503fa))
* add extension hooks and legacy approval support with tests ([c552c1c](https://github.com/khongtrunght/codex-acp/commit/c552c1c12a2c18c96956fb448960be5005f492fa))
* bootstrap TypeScript ACP bridge for codex app-server ([e775101](https://github.com/khongtrunght/codex-acp/commit/e775101e28d0ed7d59abdbfb3b34b1bddcf9b5d9))
* echo ACP messageId as userMessageId in prompt response ([2f1effd](https://github.com/khongtrunght/codex-acp/commit/2f1effd596ffc85650d10705ed8e9c18487eef4e))
* gate extension hooks behind explicit client opt-in ([0ff7af7](https://github.com/khongtrunght/codex-acp/commit/0ff7af78d54fbd51010dccb046e1599796584fe2))
* improve parity with plan streaming, terminal meta, and request fallbacks ([14da5ac](https://github.com/khongtrunght/codex-acp/commit/14da5ac0bf7cf4d73a966ceff328eb8d77b583e2))
* map ACP mcpServers into codex thread config ([09aab7e](https://github.com/khongtrunght/codex-acp/commit/09aab7e3f48513dc423f3a4abf3d59922ff43bfd))
* map SSE MCP servers and add coverage for transport mapping ([ca1d2c3](https://github.com/khongtrunght/codex-acp/commit/ca1d2c310c5a1e1e22ce84df7af6b09865fbd8d2))
* publish available commands update and add extension-first request handling ([d432001](https://github.com/khongtrunght/codex-acp/commit/d432001dcc7aae2e2250cbc33e38469e2630da7d))
* stream command and file-change output deltas as ACP tool updates ([c62eaf2](https://github.com/khongtrunght/codex-acp/commit/c62eaf26f96604191f6f2a69c097a3f1b5896218))
* support ACP resume/fork sessions and align sessionId with thread id ([22f13cb](https://github.com/khongtrunght/codex-acp/commit/22f13cba81aaf83548865cf893498c687de4293a))
* vendor codex protocol types and strengthen bridge parity ([c0adee6](https://github.com/khongtrunght/codex-acp/commit/c0adee69daf84c67b60046f078558741889653b2))

## 0.1.0 (unreleased)

- Initial public release of `codex-acp-bridge`: an ACP adapter for the Codex app-server.
