# Implementation Status

Status: **M0–M10 first-pass complete + OAuth implemented**. All test suites green.

## What was built (3 parallel subagents)

### `extension/` — Burp Suite Pro extension (Kotlin, Montoya 2026.7)
- `BurpAgentExtension.kt` — entrypoint, suite tab, unload handler
- `RpcServer.kt` — WebSocket **server** (127.0.0.1, random port), JSON-RPC 2.0, handshake auth (`handshake.hello` projectId+nonce+token, 401 on bad token), streaming, idempotencyKey cache, bidirectional (extension→sidecar requests too)
- `SidecarManager.kt` — auto-spawns sidecar (bin/burp-sidecar → dist/index.js via node → tsx), passes env (`BURP_AGENT_WS_URL/TOKEN/NONCE/PROJECT_ID`), 30s handshake wait, kill on unload
- `handlers/` — selected.get, history.search/get/inventory/websockets, http.send/batch/race, mutate.preview, tool.repeater/intruder/comparer/organizer, site_map.list/add/issues, scope.get/add/remove, proxy.set_intercept, config.export/import, task_engine.pause/resume, oob.session/poll (real Collaborator), websocket.create/send/close, auth.switch_context, scan.crawl/audit/add_requests/task_status/stop/report, bchecks.register, scan.check.register, finding.*/evidence.* (passthrough to sidecar), logger.read
- `Policy.kt` — deterministic guardrails: scope check, method/mode policy, blocklist, budget, killAll flag, redirect guard, approval-gated actions (`approval.requested`→`agent.approve` + Burp dialog)
- `Redactor.kt` — masks Authorization/Cookie/Set-Cookie/Proxy-Authorization + token/api_key/password/secret, per-cookie values
- `Mutation.kt` — declarative mutations (replace_path/query, set/remove_header, replace_body, json_path_set, form_field_set, set_method) + Content-Length recompute
- `AgentTab.kt` — Swing: status panel (sidecar/providers), chat panel (streaming text), audit log table, red **STOP ALL**
- `ContextMenuProvider.kt` — Proxy/Repeater/Target/Scanner → "Agent > Ask about selection", "Analyze request/response"
- Tests: `RedactorTest`, `MutationTest`, `PolicyTest`, `RpcFramingTest` — **38 pass**
- Fat jar: `extension/build/libs/extension-0.1.0.jar` (2.4 MB, deps bundled)

### `sidecar/` — Node/TS sidecar
- `store.ts` — SQLite (better-sqlite3) with JSON-file fallback; tables runs/messages/findings/evidence/tool_log/settings
- `config.ts` — CONFIG_PATH env → config.json → config.example.json; API keys from env only; `oauth` section added
- `redact.ts` — header + cookie + body secret masking
- `providers.ts` — unified `{stream, listModels, healthCheck}`: openai / anthropic / deepseek / ollama; **OAuth token resolver** (API key wins, else OAuth session token); normalized events
- `rpc.ts` — `ws` JSON-RPC 2.0 server, handshake gate, streaming, idempotency dedup, `setClientSocket`/`emit`/`request` bridge
- `auth/` — **NEW OAuth module**:
  - `codex.ts` — Codex CLI-compatible **device-code flow**, reads/writes shared `~/.codex/auth.json` (AuthDotJson schema), refresh + revoke
  - `claude.ts` — Claude Code-compatible **PKCE auth-code loopback flow**, reads/writes shared `~/.claude/.credentials.json`, refresh + revoke
  - `manager.ts` — unified auth manager (loginStart/LoginPoll/logout/accessToken/status) + per-provider config
  - Endpoints/configurable in `config.json` `oauth` block (defaults = Codex CLI / Claude Code public endpoints)
- `agent/` — **NEW multi-agent run engine**:
  - `orchestrator.ts` — planner→plan→round-robin executors, global budget split (80/20), finding dedup, pause/resume/cancel/kill, approval gate (5-min default-deny)
  - `executor.ts` — per-endpoint agent loop, tool-call parsing, approval policy (manual/smart/autonomous), budget consumption, policy-block tolerance
  - `rpc-bridge.ts` — routes sidecar-local methods (payload./crypto./finding./evidence./report./notify./settings./models./auth./oob./vault.) to local handlers, everything else forwards to extension over WS
  - `budget.ts` — request/duration/cost tracker + semaphore concurrency limiter
  - `run-handler.ts` — `agent.run.start/pause/resume/cancel/kill/status`, `agent.approve`
- `handlers/` — auth.status (real OAuth status), models, payload.encode/obfuscate/build, crypto.jwt, oob (local stub), notify, vault, mcp, sandbox (rejects), finding, evidence, report.generate (4 platforms), settings, agent.chat
- Tests: **71 unit + 2 contract pass** (incl. 3 real device-flow OAuth tests against mock)

### `fixtures/` — test infrastructure
- `http_server.ts` — IDOR, SQLi, redirect, XSS reflect, echoheaders, big body, rate-limit 429, auth 401; SCENARIO gating
- `ws_server.ts` — subscribe/ping/broadcast/order message
- `provider_mock.ts` — OpenAI-compatible SSE streaming + tool_calls, /v1/models, PROVIDER_FAIL modes
- `oauth_mock.ts` — device flow (pending→approve→tokens, refresh)
- Tests: **31 pass**; 12 skills validated

### `skills/builtin/` — 12 skills (skill.yaml + PROMPT.md)
request-explainer, history-triage, attack-surface-map, sqli-hunter, xss-hunter, ssrf-hunter, idor-candidate, auth-bypass-check, race-hunter, scan-check-author, finding-validator, report-writer

### `docs/` — architecture, quickstart, security, run-lifecycle, skill-authoring, burpai-comparison

### `scripts/` — dev-sidecar.sh, test-all.sh, start-fixtures.sh, integration-smoke.mjs, chat-test.mjs, oauth-debug.mjs

## Verified (ran here, all pass)
- `scripts/test-all.sh` → fixtures + sidecar **102/102**
- `./gradlew :extension:test` → **38/38**, `shadowJar` → 2.4M jar
- `scripts/integration-smoke.mjs` → **25/25** (sidecar↔mock provider↔fixtures)
- `scripts/chat-test.mjs` → **streaming agent.chat PASS**
- **Real Codex session detected** on this machine: `~/.codex/auth.json` (`auth_mode: chatgpt`) → OAuth module reads it, `auth.status` reports `method:oauth, user:<email>`

## Known API limitation (documented, verified by jar inspection)
**No `HttpConnection.localProxy()` / proxy-routing in Montoya 2026.7.** Extension-sent requests appear in Logger, CANNOT enter Proxy listener → not in Proxy > HTTP history. Workaround: agent results added to Site Map + agent MessageRefs.

## Remaining (next pass)
1. **OAuth wired but UI-level login** — `auth.login.start/poll` RPC work; Burp tab needs a login button/modal + device-code display (currently triggered via RPC only).
2. **WASM sandbox (M6)** — `sandbox.run` rejects; skill scripts not runnable yet.
3. **MCP (M6)** — registry stub, no real MCP server integration.
4. **OS keychain (M6/M10)** — vault uses JSON store fallback (`keychain:false`); provider tokens stay in `auth.json`/`.credentials.json` (shared, per decision).
5. **Live Burp smoke** — needs real Burp GUI on Windows (`/mnt/c/BurpSuitePro/burpsuite_pro.jar`): load `extension-0.1.0.jar`, verify sidecar spawn + handshake + chat.
6. **Prompt library, per-chat tool toggle, ask-selected-text UI polish** — context menu has "Ask about selection" + "Analyze"; prompt library/next-step suggestions are design-doc items not yet wired into the chat tab.

## Quickstart (dev)
```
# fixtures
cd fixtures && npm i && npm run build
bash ../scripts/start-fixtures.sh
# sidecar
cd sidecar && npm i && npm run build
CONFIG_PATH=config.json npm start   # set real authToken in config.json
# smoke
node scripts/integration-smoke.mjs
# extension
cd /mnt/e/lab/burp && ./gradlew :extension:shadowJar
# then load extension/build/libs/extension-0.1.0.jar into Burp Pro
```
