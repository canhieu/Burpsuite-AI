# Security Model

Core principle: **the extension holds all Burp powers; the sidecar holds all
intelligence; no secret ever reaches the model; nothing touches out-of-scope.**

## Redaction

- All HTTP request/response bodies returned to the sidecar are REDACTED by the
  extension before leaving it, unless the caller explicitly passes `redacted:false`
  (allowed for local providers only).
- Default mask set: `Authorization`, `Cookie`, `Set-Cookie`,
  `Proxy-Authorization`, `X-*token*`, `api_key`, `password` — configurable regex bank.
- Redaction happens at the extension boundary. Mutation paths re-inject secrets
  server-side in the extension only, never in the model context.
- Exports (HAR / markdown / JSON) always strip cookies and keys; screenshots are
  disabled by default in reports.
- The model never sees real cookies/tokens by default. The model's view of a
  request is a redacted skeleton: method, path, params, headers (masked), body (masked).

## Policy gates (deterministic, never model-decided)

- **Scope gate:** in-scope only. Empty scope = refuse to run. Out-of-scope
  redirect = stop. No automatic scope-add.
- **Budget gate:** requests / duration / RPS / concurrency / tokens / cost caps —
  per run and per skill; hard wall-clock cap. Exceeded budget → `429`.
- **Method gate:** destructive or state-changing methods outside a skill's allowlist
  need approval.
- **Blocklist:** program platform domains (hackerone.com, bugcrowd.com, …) and
  third-party CDN/payment origins unless explicitly in scope.
- **Redirect guard:** responses that redirect out of scope stop the current action.
- **DNS-rebinding protection:** resolve-then-verify for agent-supplied hosts.
- **Smuggling guard:** conflicting CL/TE crafted frames are rejected unless approved.
- **Throttle:** global token bucket + per-host throttle + jitter; scan tasks use
  Burp's own throttle.

Policy-blocked sends return RPC `403` with `data.reason`.

## Approval matrix

Always human-approve (`approvalPolicy: approval`), regardless of skill:

| Action | Default |
|---|---|
| `http.send` with mutation (`mutate.apply`) outside a detection skill | approval |
| Delete / destructive actions, irreversible state changes | approval |
| Out-of-scope redirect follow | approval |
| `scope.add` / `scope.remove` | approval |
| `config.import` | approval |
| `proxy.set_intercept` toggle | approval |
| `bchecks.register`, `scan.check.register`, `scan.audit`/`crawl` launch | approval |
| `scan.report` / `report.generate` writing to a path | approval |
| Non-loopback MCP servers, `mcp.call` to remote | approval |
| Non-sandbox scripts | approval |
| Requests to program-platform domains | approval |
| `notify.send` (Telegram/webhook) | approval |

Auto-approved (`approvalPolicy: auto`) only within skill + scope + budget allowlist:
read-only probing, `http.send` in detection skills, race bursts, OOB sessions,
WS send, JWT forge-then-send.

## Prompt-injection defense (3 layers, strict)

1. **Untrusted zone:** response bodies and tool output enter context only as
   `<untrusted data>`-tagged, tool-verified summaries — never appended raw to the
   system prompt.
2. **Instruction guard:** data containing instructions ("ignore previous
   instructions") is quarantined; the model is configured to never obey
   data-borne instructions.
3. **Read-only echo:** anything the agent wants to "execute" must go through real
   tools + policy — never accepted from text in a response body.

## Secret handling

- API keys and provider tokens are **env-only** (`OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, …) or in shared OAuth credential files
  (`~/.codex/auth.json`, `~/.claude/.credentials.json`) with mode 0600 + atomic writes.
- Never store secrets in: Burp project files, SQLite knowledge store, logs, skills,
  notifications, or reports.
- Test-account credentials may live in the OS keychain (`vault.*`), never in the model path.
- Sidecar handshake token: from `BurpSuite.commandLineArguments()` / temp file,
  never logged, never sent to any model.
