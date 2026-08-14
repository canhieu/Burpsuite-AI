# Burp Agent — Architecture

## System diagram

```
┌────────────────────────────────────────────────────────────────┐
│ Burp Suite Pro 2026.x (Java 17) — Montoya API 2026.7            │
│  Extension (Kotlin) — "BurpBridge"                              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ • Proxy: history, WS history, request/response handlers, │  │
│  │   master intercept control, annotations                  │  │
│  │ • Scanner: startCrawl/startAudit, ScanCheck (active/     │  │
│  │   passive), AuditIssueHandler, generateReport, BChecks   │  │
│  │ • HTTP: sendRequest (+HttpConnection.localProxy →        │  │
│  │   Proxy history), cookies, session, RequestOptions       │  │
│  │ • Tools: Repeater, Intruder, Comparer, Organizer,        │  │
│  │   SiteMap (read/write issues), Collaborator, Scope R/W,  │  │
│  │   config import/export, task engine pause/resume,        │  │
│  │   UI tabs + context menu                                 │  │
│  │ • Policy Engine: scope, budgets, approval gates,         │  │
│  │   redaction, idempotency, kill switch, prompt-injection  │  │
│  │   untrusted-zone tagging                                 │  │
│  └──────────────────────────────────────────────────────────┘  │
│                ▲ JSON-RPC 2.0 over WebSocket (loopback only)   │
│                │ handshake: project ID + nonce + auth token    │
└────────────────┼───────────────────────────────────────────────┘
┌────────────────▼───────────────────────────────────────────────┐
│ Sidecar (TypeScript/Node 20) — lifecycle bound to Burp,        │
│ state persisted to SQLite (resume after Burp restart)          │
│  • Agent core: orchestrator + executors (multi-agent), tool    │
│    loop, memory tiers, compaction, retry + idempotency         │
│  • Providers: OpenAI/Codex, Anthropic, DeepSeek,               │
│    Ollama/vLLM/LM Studio; per-role model profiles              │
│  • Auth: API keys (env) + OAuth (Codex CLI & Claude Code       │
│    compatible — shared credential files)                       │
│  • Exploitation engine: attack templates, payload bank, WAF    │
│    bypass, race driver, OOB (Collaborator), chain builder,     │
│    auth-context differential                                   │
│  • Extensions: WASM skill sandbox, MCP client, OS keychain     │
│    vault, notifications (Telegram/webhook)                     │
│  • Skills: manifest, router, importers, built-in catalog       │
│  • Knowledge: SQLite (references, findings, evidence, runs,    │
│    cost, auth contexts) — never secrets                        │
└────────────────────────────────────────────────────────────────┘

              ┌──────────────────────────────────────┐
              │ fixtures/ (test infrastructure)       │
              │  http mock (target app)     port 9000 │
              │  ws echo/chat mock          port 9001 │
              │  provider mock (OpenAI)     port 9002 │
              │  oauth device-flow mock     port 9003 │
              └──────────────────────────────────────┘
```

## Component responsibilities

### Extension (Kotlin, "BurpBridge") — the hands
- Owns every Burp capability: proxy history + websockets, scanner, HTTP send path,
  Repeater/Intruder/Comparer/Organizer handoffs, SiteMap, Collaborator, scope,
  config, task engine.
- Is the ONLY component that touches Burp's network stack, cookie jar, and TLS settings.
- Enforces the policy engine deterministically: scope, budgets, approval gates,
  redaction, idempotency, kill switch, untrusted-zone tagging.
- Never contains model secrets; restores secrets into mutation paths server-side only.
- Speaks JSON-RPC 2.0 over a loopback WebSocket to the sidecar; auto-spawns it.

### Sidecar (Node/TS) — the brain
- Orchestrator + N executors (multi-agent), the tool loop, memory tiers, compaction,
  retry + idempotency.
- Provider adapters (OpenAI/Codex, Anthropic, DeepSeek, Ollama/vLLM/LM Studio),
  per-role model profiles, OAuth flows.
- Exploitation engine: attack templates, payload bank, WAF bypass, race driver,
  OOB (Collaborator), chain builder, auth-context differential.
- Skills: manifests, router, importers, built-in catalog.
- Extensions: WASM sandbox, MCP client, OS keychain vault, notifications.
- Persists run state to SQLite so a run can be resumed after a Burp restart.

### Fixtures — the test harness both sides depend on
- Deterministic mocks so the extension and sidecar can be developed and tested
  without a live target or live LLM:
  - `http_server.ts` — target-app mock with vulnerable-by-design routes
    (IDOR owners, SQLi error, XSS reflection, redirect, rate limit, big body).
  - `ws_server.ts` — websocket echo/chat with subscriptions, pings, and a
    per-account order message for WS IDOR tests.
  - `provider_mock.ts` — OpenAI-compatible `/v1/chat/completions` +
    `/v1/responses` with SSE streaming, tool-call detection, and failure modes.
  - `oauth_mock.ts` — device-flow OAuth with approval-gated token issuance and
    refresh grants.
- Default ports 9000–9003, bind 127.0.0.1, overridable via `PORT`/`HOST`.

## Transport

- JSON-RPC 2.0 + server-push events over WebSocket (loopback only).
- Handshake: `handshake.hello` `{projectId, nonce, token}` → `agent.hello`.
- Run lifetime tied to Burp; SQLite persists state for "Resume last run".
- Full method/event contract in `PROTOCOL.md`.
