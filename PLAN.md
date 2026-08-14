# Burp Agent — Master Plan v2

Multi-LLM autonomous security agent for Burp Suite Pro — a bug bounty exploitation platform.

**Priority (user decision):** exploitation power > reporting > autonomy. All three ship, but M6 (exploitation) gets double investment.

---

## 1. Vision

A multi-LLM agent embedded in Burp Suite Pro that **finds → validates → exploits → reports** vulnerabilities on authorized bug bounty targets. Human stays in control via deterministic policy gates; the AI does the heavy lifting: history triage, endpoint mapping, targeted probing, exploitation chains, evidence capture, and program-ready reporting.

**Core principle:** the extension holds all Burp powers; the sidecar holds all intelligence; no secret ever reaches the model; nothing touches out-of-scope.

---

## 2. Architecture

```
┌────────────────────────────────────────────────────────────────┐
│ Burp Suite Pro 2026.x (Java 17) — Montoya API 2026.7 (verified) │
│  Extension (Kotlin) — "BurpBridge"                              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ • Proxy: history, WS history, request/response handlers, │  │
│  │   master intercept control, annotations                  │  │
│  │ • Scanner: startCrawl/startAudit, ScanCheck (active/     │  │
│  │   passive), AuditIssueHandler, generateReport, BChecks   │  │
│  │ • HTTP: sendRequest (+HttpConnection.localProxy →        │  │
│  │   Proxy history), cookies, session, RequestOptions       │  │
│  │ • Tools: Repeater (sendToRepeater), Intruder             │  │
│  │   (sendToIntruder + HttpRequestTemplate), Comparer,      │  │
│  │   Organizer, SiteMap (read/write issues), Collaborator   │  │
│  │   (full client), Scope R/W, config import/export, task   │  │
│  │   engine pause/resume, UI tabs + context menu            │  │
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
```

**Transport:** JSON-RPC 2.0 + server-push events over WebSocket (loopback only). Sidecar auto-spawned by extension (Windows exe → WSL node → system node). Handshake: project ID + nonce + auth token (from `BurpSuite.commandLineArguments()` / temp file). Token never logged. Run lifetime tied to Burp; SQLite persists state for "Resume last run".

**Why extension + sidecar:**
- Requests go through Burp's network stack, proxy, cookie jar, TLS settings
- Model never sees real cookies/tokens by default
- Switching models requires no extension rebuild
- Agent errors never hang the Swing UI
- Easy to add models, skills, MCP later

---

## 3. Providers & Auth

| Provider | API key (M1) | OAuth (M10) | Local |
|---|---|---|---|
| OpenAI/Codex | `OPENAI_API_KEY` | Codex CLI-compatible: device flow → browser fallback; shared `~/.codex/auth.json` (`auth_mode`, `tokens`, `last_refresh`, `OPENAI_API_KEY`), chmod 600, atomic write | — |
| Anthropic | `ANTHROPIC_API_KEY` | Claude Code-compatible: auth-code + PKCE loopback; shared `~/.claude/.credentials.json` | — |
| DeepSeek | `DEEPSEEK_API_KEY` | — | — |
| Ollama/vLLM/LM Studio | — | — | `GET /api/tags` / `/v1/models`, no key |

- **M1 spike:** does ChatGPT OAuth access token still authorize `POST /v1/responses` (Bearer), or is AgentIdentity registration (`/backend-api/wham/...` — verified in codex source `agent_identity.rs`) mandatory for new accounts? Implement whichever is proven.
- Token lifecycle: refresh grant (`auth.openai.com/oauth/token`, `grant_type=refresh_token`), single-flight, pre-expiry refresh, revoke on logout. `OPENAI_API_KEY` env > file.
- Unified adapter interface: `stream()`, `capabilities()` (tool-call, vision, cost model), `healthCheck()`. Dynamic model list per provider (OpenAI `/v1/models`, Claude `/v1/models`, DeepSeek `/models`, Ollama `/api/tags`), alias resolution (`latest-codex`), role profiles: `planner` (strong) / `executor` (fast) / `reviewer` (strong) / `fast` (triage).
- **Local-only mode (M1/M4):** global switch forcing all providers to local endpoints + hard network block in sidecar (PortSwigger-local-LLM equivalent).
- API keys are never stored in Burp project, SQLite, logs, or skills — env vars only (or OS keychain for test-account credentials, see §10).

---

## 4. Tool Catalog (API-verified)

### Read / intel
`get_selected_http` · `search_http_history` (scope/host/path/method/status/MIME/time/text) · `get_http_message` (ref + body slice/search) · `list_site_map` · `list_scope` · `list_issues` (SiteMap + AuditIssueHandler) · `list_websocket_history` · `get_websocket_thread` · `compare_messages` · `inventory_endpoints` (normalize/dedup/summarize) · `logger.read`

### HTTP actions
`send_http` (`via: proxy|direct` — **default proxy** → `HttpConnection.localProxy()` → lands in Proxy HTTP history) · `send_http_batch` (concurrency/RPS/rate window) · `race_burst` (N concurrent identical requests — single-packet attack emulation) · `replay_http` · `mutate_and_send` (declarative path/query/header/body/JSON-path/form/multipart mutations; secrets restored extension-side) · `send_to_repeater` (tab name) · `send_to_intruder` (+`HttpRequestTemplate` insertion points, named tab) · `send_to_comparer` · `send_to_organizer`

### Exploitation primitives
`payload.encode/decode` (url/base64/hex/json/unix-time/HTML entities…) · `payload.obfuscate` (WAF bypass bank: case, unicode, comment folding, chunking, double-encode, whitespace) · `payload.build` (attack templates: SQLi, XSS, SSTI, SSRF, XXE, traversal/LFI, command injection, header injection, upload polyglots, JWT tamper) · `crypto.jwt_analyze` (header/payload manipulation, alg confusion, signature strip, weak HMAC) · `oob.session` / `oob.poll` (Collaborator: payload gen + DNS/HTTP interaction poll — OOB proof) · `websocket.create` / `websocket.send` (new or from upgrade request; mutate JSON-RPC / GraphQL-sub / Socket.IO frames) · `auth.switch_context` (accountA/accountB/anon)

### Scanning
`scan.crawl` (`CrawlConfiguration`) · `scan.audit` (`AuditConfiguration`, built-in presets) · `scan.add_requests` · `scan.task_status` (counts/errors/issues; `statusMessage()` known-unimplemented → poll counts) · `scan.stop` · `scan.check.register` (custom Active/Passive `ScanCheck` + `ScanCheckType`) · `bchecks.register` · `scan.report` (`generateReport(issues, HTML/XML, path)`)

### Platform (approval-gated)
`proxy.set_intercept` (enable/disable master intercept — required OFF during autonomous runs) · `scope.get/add/remove` (add/remove = approval) · `config.export/import` (project/user options JSON, approval) · `task_engine.pause/resume` · `organizer.read`

### Extensions (M6)
`mcp.call` (`mcp.<server>.<tool>` namespace, local servers only by default) · `sandbox.run` (WASM skill script, no FS/network) · `vault.set/get/delete` (test-account credentials, OS keychain) · `notify.send`

### Evidence / report
`finding.create/update` · `evidence.pin` (request/response pairs + collaborator interactions + timing + diff + skill + run) · `evidence.export` (redacted HAR/Markdown/JSON) · `report.generate` (per-program) · `issue.add_to_burp` (`AuditIssue` factory → `SiteMap.add`)

---

## 5. Agent Engine (Multi-Agent)

```
Orchestrator (1, strong model)
 ├─ plan → split into endpoint tasks
 ├─ spawn Executors (1 agent/endpoint, cheaper model, own skill)
 ├─ shared findings pool (dedup lock, knowledge store)
 ├─ global budget → per-executor allocation (requests/tokens/cost)
 └─ executor failure → resume/reassign; Kill = kill all
Executors (N parallel, configurable max)
 └─ own tool loop; push observations to orchestrator
```

- **Memory tiers:** (1) task context window with budget, (2) SQLite run store for cross-session recall, (3) project knowledge base (endpoints, auth contexts, anomalies).
- **Orchestration loop:** plan (visible) → step → tool call → observe → conclude. No hidden chain-of-thought in UI — only goals, actions, observations, findings.
- **Retry & idempotency:** every mutating tool call carries `idempotencyKey` (hash of run+call+target+payload); provider retries never double-send; read-tool dedup.
- **Cancellation:** STOP ALL → halt orchestrator → cancel in-flight batches → kill owned scan tasks → persist state. Extension unload / WS drop → same.
- **Multi-model:** single orchestrator or role-split with shared `ToolCall` schema (OpenAI function calling / Anthropic tool use / DeepSeek tool use normalized).
- **Guardrails (deterministic, never model-decided):**
  - Scope: in-scope only; empty scope = refuse; out-of-scope redirect = stop; no auto scope-add.
  - Budgets: requests / duration / RPS / concurrency / tokens / cost — per run and per skill; hard wall-clock cap.
  - Blocklist: program platform domains (hackerone.com, bugcrowd.com…), third-party CDN/payment origins unless in scope; DNS-rebinding protection (resolve-then-verify for agent-supplied hosts).
  - Smuggling guard: reject conflicting CL/TE crafted frames (approval required).
  - Global token bucket + per-host throttle + jitter; scan tasks use Burp's own throttle.
  - Every tool call logged: redacted input, output summary, model, skill, cost, timestamp.

- **Prompt-injection defense (strict, 3 layers):**
  1. **Untrusted zone:** response bodies / tool output enter context only as `<untrusted data>`-tagged, tool-verified summaries — never appended raw to the system prompt.
  2. **Instruction guard:** data containing instructions ("ignore previous instructions") is quarantined; the model is configured to never obey data-borne instructions.
  3. **Read-only echo:** anything the agent wants to "execute" must go through real tools + policy — never accepted from text.

---

## 6. Exploitation Engine (M6 — Core, double investment)

### A. Attack template library (15+ classes)
- **SQLi:** error-based, union, boolean/time blind (OOB via Collaborator), NoSQL (`$regex`, `$where`, Mongoose), ORM raw fragments, GraphQL
- **XSS:** reflected/stored/DOM, context-aware (attr/JS/JSON/HTML), CSP parse (sidecar), mutation-XSS
- **SSRF:** http/https/gopher/file, metadata IPs (169.254.169.254, 100.100.100.200), DNS rebinding, OOB proof mandatory
- **SSTI:** polyglot math probes → engine fingerprint (Jinja2/Twig/Freemarker/Thymeleaf/ERB) → RCE chain
- **Path traversal / LFI:** double-encode, null-byte legacy, `php://filter` chain builder, `phar://` (needs upload primitive)
- **IDOR/BOLA:** ID fuzzing with **two-account differential** (auth-context switching)
- **Auth:** JWT alg-confusion, signature strip, audience/issuer mismatch, reset-token logic chains, OAuth state/redirect manipulation
- **Race conditions:** `race_burst` against coupon/gift-card/OTP/email-verify/vote endpoints + response-diff verdict
- **File upload:** extension/format polyglots, ZIP-slip, SVG XSS, XXE-in-DOCX, `.htaccess` enable-exec
- **Command injection:** error-based, time-based OOB, blind with Collaborator
- **Desync/smuggling:** probe via time-delay; full chain requires approval
- **WebSocket:** auth bypass, frame IDOR, subscription leaks (GraphQL `connection_init` auth missing)
- **Open redirect · CSRF · Info-leak · Account takeover (chain)**

### B. Chain orchestrator (A→B→C)
Agent builds multi-step chains: upload → phar trigger → LFI read; SSRF → metadata → keys → deeper; signup → race → admin flag. Each chain step carries evidence; chain-level success criteria in skill `output_schema`.

### C. Auth-context manager
Sidecar stores **references** (never raw secrets to the model): `authCtx: "accountA" | "accountB" | "anon"`. Extension restores cookies/headers per context from history (latest in-scope session for that account) or OS keychain credentials. Drives differential tests, tenant isolation, ATO checks.

### D. Verification gates before exploitation
- Passive fingerprint + info phase first; never blind-exploit a parameter with no signal.
- **Auto within allowlist** (`approval_policy: auto` in skill.yaml): state-changing exploits (POST/PUT/DELETE/PATCH, mutate, race, upload, WS send) run automatically when inside skill + scope + budget allowlist.
- **Always human-approve:** delete of significant data, out-of-scope redirects, scope changes, config import, intercept toggle, non-loopback MCP servers, non-sandbox scripts, requests to program-platform domains.
- OOB-only proof for blind classes (Collaborator interaction = mandatory evidence).
- After exploit: **verify + revert** (if reversible — e.g., delete test object); confirm cleanup.

### E. WAF bypass bank
Case, unicode, comment-folding, chunking, double-encode, whitespace variants; context-adaptive re-encode.

### F. AI-authored BChecks loop (Burp AT equivalent)
Agent reads a request + hypothesis → writes a BCheck → registers via `bChecks()` API → runs audit → `AuditIssueHandler` captures issues → agent reviews and refines → repeat (max N). Deterministic Scanner executes AI hypotheses.

---

## 7. History & Data Plane

- **Indexing:** extension filters in-scope → normalizes to endpoint inventory (method/host/route shape/params/status/MIME/cookies used) → incremental delta events to sidecar (10k events/batch, debounced).
- **Lazy bodies:** fetched on demand via `get_http_message` slices; binary → metadata + text-extraction only; responses >50KB truncated with offsets.
- **References:** `{projectId, source: "proxy"|"siteMap"|"agent", id, digest}` — SQLite stores references + summaries, never raw history.
- **Dedup:** content-hash clustering (identical bodies), route-shape clustering for inventory.
- **Redaction:** default mask `Authorization`, `Cookie`, `Set-Cookie`, `Proxy-Authorization`, `X-*token*`, `api_key`, `password` (configurable regex bank); local providers can opt into full visibility; mutation paths re-inject secrets server-side in the extension only.

---

## 8. Skills System

```
skills/<name>/
├── skill.yaml     (id, version, triggers, tools.allow/deny,
│                   limits {requests, duration, concurrency, cost},
│                   input_schema, output_schema, model_preference,
│                   auth_required [anon/accountA/dual],
│                   evidence_requirements, approval_policy [auto/approval],
│                   scripts[] (WASM, hash-pinned), mcp[] (allowed servers))
├── PROMPT.md
├── workflow.yaml
├── *.schema.json
└── README.md
```

- Importers: Codex `SKILL.md`, Claude slash-commands, generic prompt dir — imported skills **read-only by default**; active tools must be enabled manually.
- **WASM sandbox (M6):** QuickJS/isolated-vm, no FS/network; injected capability object only (payload utils, math, encoding, `http()` via tool protocol). Scripts hash-pinned in `skill.yaml`.
- **MCP (M6):** sidecar = MCP client (`@modelcontextprotocol/sdk`); connects to **local MCP servers (stdio/TCP loopback)**; tool namespace `mcp.<server>.<tool>`; policy applied identically to Burp tools (scope/approval/budget); remote MCP servers = approval + flag.
- **Built-in catalog (bug bounty oriented):**
  - Intel: `history-triage`, `attack-surface-map`, `auth-context-map`, `endpoint-inventory`, `websocket-triage`
  - Detection: `sqli-hunter`, `xss-hunter`, `ssrf-hunter`, `ssti-hunter`, `idor-candidate`, `auth-bypass-check`, `race-hunter`, `file-upload-audit`, `desync-probe`, `jwt-audit`, `open-redirect`, `csrf-audit`, `info-leak`, `issue-explainer`
  - Exploitation: `sqli-exploit` (blind/OOB), `xss-poc-build`, `ssrf-oob-chain`, `ssti-rce`, `idor-differential`, `race-double-spend`, `upload-rce-chain`, `account-takeover-chain`, `scan-check-author` (BCheck loop)
  - Ops: `scanner-orchestrator`, `finding-validator` (7-question gate), `evidence-capturer`, `report-writer`, `bb-methodology` (recon → triage → exploit → report lifecycle)

---

## 9. Scanner Integration (M7)

Agent flow: check Burp Pro capability → check scope/seed → seed from selected request / site map / history → `startCrawl` → monitor request/error counts (`statusMessage()` known-unimplemented → poll counts) → collect new endpoints from site map → passive audit → active audit (profile-gated) → `AuditIssueHandler` ingest → correlate with history + agent evidence → findings → report.

Plus: custom `ScanCheck` registration (active/passive with `ScanCheckType`) and the **BCheck author loop** (§6.F). Known limits: public API presets only, `Crawl.statusMessage()` unimplemented, no access to Burp AT proprietary internals; deep custom scan config deferred (experimental via partial project JSON import).

---

## 10. Findings, Evidence & Reporting (M9)

```
finding: {
  id, title, vulnClass, severity (CVSS 3.1), confidence,
  status: candidate|validated|confirmed|rejected|duplicate,
  evidence[]: {kind: request-response|collaborator|diff|timing|screenshot-note,
               refs[], redacted payload, timestamp},
  chain[], skill, runId, program, assets[]
}
```

- **Validation gates (deterministic):** evidence rules per class — IDOR = 2-account differential with distinct owner data; blind SQLi = Collaborator DNS hit; race = ≥2 distinct successes with monotonic state. Confidence never set by the model alone — rule-based votes first.
- **Dedup:** hash(asset+class+path+param) within project; cross-run dedup; link to Burp issue (`SiteMap.add` AuditIssue + Organizer).
- **Reports — 4 platforms:** HackerOne, Bugcrowd, Intigriti, Immunefi templates — CVSS 3.1, impact statement, PoC steps, remediation, redacted evidence; sanitized HAR (cookie/authorization stripped); Burp HTML report via `generateReport`.
- **Evidence hygiene:** redaction at extension boundary; exports strip cookies/keys; screenshots disabled-by-default in reports.
- Post-submit: rotate test accounts, revoke Collaborator sessions, cleanup payloads.

---

## 11. Notifications (M4)

Telegram bot + generic webhook. Events: `finding.new`, `run.done`, `approval.requested`, `agent.error`, `budget.warning`. Redacted content only — no tokens, no sensitive target URLs.

---

## 12. Protocol (contract `protocol/`, JSON Schema — M0)

RPC: `agent.chat` · `agent.run.start/pause/resume/cancel/kill` · `agent.run.status` · `skill.list/load/import/run` · `history.search/get/inventory` · `http.send/batch/race` · `mutate.preview/apply` · `payload.*` · `oob.session/poll` · `scan.*` · `bchecks.*` · `finding.*` · `evidence.*` · `auth.status/login/logout` · `vault.*` · `mcp.*` · `notify.*` · `settings.get/set` · `config.*` · `proxy.set_intercept` · `scope.*` · `task_engine.*`

Events: `agent.event` · `run.progress` · `tool.call` · `finding.updated` · `approval.requested` · `auth.status.changed`

**Contract tests Java↔TS generated from the schema.**

---

## 13. UI (native Burp, dark/light aware)

Tab `Agent`: **Tasks | Chat | Context | Tool Timeline | Runs | Skills | Findings | Settings**

- **Chat:** cards — gray=reasoning/note, blue=read tool, orange=send/scan, red=error/policy block, green=validated finding. Skill card, tool-call card (input, result, [View request] [View response] [Compare]), candidate-finding card ([Validate] [Reject] [Save evidence]). No chain-of-thought shown. **Suggest-next-steps** buttons after each analysis.
- **Request viewer:** native Burp HTTP editors + Diff + Metadata + [Send to Repeater] [Open in Comparer] [Add to Organizer] [Pin as evidence] [Copy as cURL (redacted)].
- **Context menu** (Proxy/Repeater/Target/Scanner): Ask Agent / Explain request/response / **Ask about selected text** / Find related traffic / Analyze for vulnerabilities / Run skill ▸ / Start autonomous test / Validate as finding.
- **Per-chat tool toggle** (Burp AI tools equivalent): read-history / send / scanner / site-map per task — overrides skill permissions for that task.
- **Runs view:** live plan (step checkmarks) + activity log + per-executor status + budgets + red **STOP ALL** always visible. Open Scanner task links.
- **Scanner view:** crawl/audit task cards with counters + [Open Dashboard] [Stop] [Add selected request].
- **WebSocket view:** grouped by connection, frame table, [Ask Agent] [Replay] [Mutate and send].
- **Skills view:** manifest table, permissions, state, import/reload, per-skill workflow + budgets.
- **Findings view:** table + detail with evidence + [Add to Burp issues] [Send to Organizer] [Generate report] [Reject].
- **Settings:** providers+auth (key source only, no key display), models, prompt library, agent profiles, autonomy, budgets, redaction rules, local-only mode, notifications, skills, MCP servers, vault, sidecar connection, storage.

---

## 14. Project Layout

```text
burp-agent/
├── extension/          (Gradle wrapper, Kotlin, Montoya API)
├── sidecar/            (Node/TS: orchestrator, executors, providers,
│                        auth, exploit engine, skills, mcp, sandbox,
│                        vault, sqlite)
├── protocol/           (rpc.schema.json, tools/, events/, bchecks/)
├── skills/builtin/
├── fixtures/           (http/, ws/, providers/, oauth mock,
│                        mcp mock, wasm, collaborator sim)
├── docs/
└── gradlew, gradlew.bat, settings.gradle.kts
```

Gradle Wrapper committed — no local Gradle install required.

---

## 15. Milestones

| Phase | Deliverables | Exit criteria |
|---|---|---|
| **M0** | Foundation: Gradle ext skeleton, sidecar, WS JSON-RPC, auth handshake, health | connect / ping / echo / version |
| **M1** | Providers (API key), Chat tab, context menu, selected request, streaming, prompt library, ask-selected-text, local-only switch, **OAuth spikes** (codex agent-identity? claude PKCE endpoints) | chat with all 4 providers on selected request |
| **M2** | History: search / inventory / slicing / redaction / references | triage 10k-entry history in <60s |
| **M3** | Tool loop: mutate/send via proxy, diff, handoffs (Repeater/Intruder/Comparer/Organizer), idempotency, cancel, per-chat tool toggle, next-step suggestions | human-in-loop tool loop |
| **M4** | Autonomy: scope / budgets / audit log / STOP ALL / intercept mgmt, notifications (Telegram+webhook), local-only enforcement | safe autonomous run; kill works |
| **M5** | Skills: manifest / router / built-in intel+detection / importers / issue-explainer / **multi-agent framework** (orchestrator+executors) | multi-executor parallel run |
| **M6** | **Exploitation core (2×)**: 15+ attack templates, payload bank, WAF bypass, race driver, OOB Collaborator, chain builder, **WASM sandbox, MCP client, OS keychain vault, auth-context differential, BCheck author loop** | exploited chains with evidence, ≥3 classes E2E |
| **M7** | Scanner: crawl / audit / monitor / issue ingest / ScanCheck / BCheck refine loop | full scan lifecycle |
| **M8** | WebSocket: history / threads / mutate / replay / exploit | WS exploitation works |
| **M9** | Findings: validation gates / dedup / 4-platform reports / Burp issue + Organizer / redacted HAR | validated report bundle |
| **M10** | OAuth (Codex device+browser, Claude PKCE, shared credential files), packaging (Windows exe, WSL dev), docs | login like `codex login` / `claude login`; shared sessions |

---

## 16. Testing

- **Fixtures:** mock OpenAI/Anthropic/DeepSeek (streams, tool calls, malformed), mock OAuth servers (device/token/refresh/expiry/concurrent refresh/corrupt file), HTTP server fixtures (redirects, auth, JSON, multipart, binary, H2, CSRF, rate-limit), WS echo, Collaborator simulator, mock MCP server, WASM sandbox tests.
- **Unit:** redaction/restore, policy matrix (scope/redirect/method/budget/blocklist), idempotency, payload encoders, template builders, finding gate logic, skill loader/importer, vault, notification redaction.
- **Contract:** JSON-RPC schema tests Java ↔ TypeScript.
- **E2E (against fixtures):** find → exploit → evidence → report; multi-executor runs; BCheck loop; prompt-injection payloads.
- **Real Burp smoke (manual checklist):** load JAR, connect sidecar, login flows, autonomous run scoped, STOP ALL, request lands in Proxy history, crawl/audit on Dashboard, WS replay, report redaction.
- **Build gates:** `./gradlew test shadowJar` + `npm ci && npm test && npm run build && npm run test:contract`.

---

## 17. Definition of Done

1. Provider/model switch without code changes; per-role profiles work.
2. Agent reads selected request + full in-scope history.
3. Agent sends / replays / mutates / races through Burp (proxy default, direct option).
4. Exploitation: 15+ classes, OOB proof for blind, chains, auth-context differential, WASM skills, MCP.
5. Raw secrets never reach remote models by default; never persist to project/SQLite/logs.
6. Autonomous always scope+budget+approval-policy bound; STOP ALL instant.
7. Skills: permission isolation; external imports read-only; sandboxed scripts.
8. Scanner lifecycle + issue ingestion + BCheck author loop.
9. WebSocket exploitation works.
10. Findings: evidence-gated, deduped, 4-platform exports, redacted.
11. OAuth: Codex + Claude compatible, shared credential files, refresh + revoke.
12. Notifications: Telegram + webhook, redacted.
13. Windows native + WSL dev both work; runs resumable after Burp restart.

---

## 18. Burp AI / Burp AT Comparison (coverage)

| Burp AI / AT feature | Status |
|---|---|
| Chat with selected request/response (Proxy/Repeater/Target) | ✅ M1 |
| Explain / Analyze request & response | ✅ M1 |
| Proxy history as chat context | ✅ M2 |
| Local LLM (no external data) | ✅ local-only mode |
| Custom prompts | ✅ prompt library (M1) |
| Ask about selected text | ✅ M1 |
| AI-generated attack payloads | ✅ M6 payload bank |
| Per-chat tool permissions | ✅ per-chat tool toggle (M3) |
| Multiple parallel conversations | ✅ Tasks |
| Burp AT: AI-authored bChecks → Scanner → AI review loop | ✅ BCheck author loop (M6/M7) |
| Burp AT: live plan view + cancel mid-run | ✅ Runs view |
| Burp AT: test specific request(s) autonomously | ✅ M4/M6 |
| Explain/triage existing Scanner issues | ✅ issue-explainer (M5) |
| Issues to Dashboard | ✅ `SiteMap.add` (M9) |
| Collaborator OOB | ✅ M6 |
| Prompt-injection defense | ✅ 3-layer isolation |

**Beyond Burp AI:** multi-provider + per-role models, OAuth shared with Codex CLI/Claude Code, open skills + importers, full Burp tool control (Intruder/Comparer/Organizer/Scope/SiteMap), proxy-listener routing (requests in Proxy history), no PortSwigger quota dependency.

**Not possible (API limits):** Burp AT/AI proprietary internals, Sequencer, Decoder (reimplemented in sidecar), Intruder auto-launch (agent uses internal batch/race), Repeater read-back, GUI automation.

---

## 19. Risks & Mitigations

- **ChatGPT token → Responses API may require AgentIdentity** → M1 spike; API-key fallback until implemented (isolated module).
- **Intruder can't auto-launch** → internal `send_http_batch` / `race_burst`; Intruder for human handoff only.
- **Scanner config depth** limited to presets + ScanCheck/BChecks → deep config deferred; partial config JSON experimental.
- **Rate limiting / banning** → global + per-host throttle, jitter, dry-run mode, OOB-based verdicts to minimize traffic.
- **Prompt injection / poisoned tool output** → 3-layer isolation (untrusted zones, guard, tool-only execution).
- **Runaway agent** → wall-clock + request + cost + host caps, approval gates, STOP ALL, error-streak auto-pause.
- **Evidence leaks** → extension-boundary redaction, sanitized exports, redacted notifications.

---

## 20. Decision Log (user-confirmed)

1. Distribution: local/private first (not BApp Store).
2. Full automation ("toàn tự động") with deterministic policy gates.
3. Providers: API + local endpoints; API-key-first MVP, OAuth later (M10).
4. Architecture: Burp extension + Node/TS sidecar, JSON-RPC over WebSocket.
5. Agent requests routed through Burp proxy by default (→ Proxy history).
6. Codex-style OAuth: own login implementation (option B), shared credential files.
7. Exploitation: auto within allowlist; approval for high-risk actions.
8. Multi-agent: orchestrator + executors.
9. WASM skill sandbox from M6.
10. MCP client from M6.
11. OS keychain for test-account credentials.
12. Reports: HackerOne + Bugcrowd + Intigriti + Immunefi.
13. Notifications: Telegram + webhook.
14. Runs bound to Burp lifecycle; SQLite resume.
15. Prompt injection: strict isolation.
16. Priority: exploitation power first.

---

## 21. Open Decisions (pending)

1. OAuth: reuse Codex CLI / Claude Code public client_id + shared credential files — OK?
2. MVP API-key-first; OAuth at M10 — OK?
3. Provider tokens in `auth.json` / `.credentials.json` (0600) files; OS keychain reserved for test-account credentials — or provider tokens in keychain too?
4. Start M0 when implementation begins?
