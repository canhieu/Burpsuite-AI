# Skill Authoring

Skills are capability manifests + prompts that gate what a model may do. A skill
lives in `skills/builtin/<id>/` (or an imported `skills/<name>/` folder):

```
skills/<name>/
├── skill.yaml     # manifest (schema below)
└── PROMPT.md      # full system prompt for the skill
```

## skill.yaml — every field

Keys mirror the `SkillManifest` type in `sidecar/src/types.ts`.

| key | type | required | meaning |
|---|---|---|---|
| `id` | string | yes | unique skill id (`kebab-case`). Folder name should match. |
| `version` | string | yes | semantic version `"1.0.0"`. |
| `name` | string | yes | human-readable display name. |
| `description` | string | yes | what the skill does; used by the router. |
| `triggers` | string[] | no | natural-language phrases that route to this skill. |
| `tools.allow` | string[] | no | RPC tool methods the skill may call. Empty/absent = none. |
| `tools.deny` | string[] | no | explicit denials (never overlaps `allow`). |
| `limits.requests` | number | no | max tool requests per run. |
| `limits.durationSeconds` | number | no | hard wall-clock cap. |
| `limits.concurrency` | number | no | parallel executor/request cap. |
| `limits.maxCostUsd` | number | no | cost cap in USD. |
| `modelPreference` | string | no | role hint: `fast` \| `strong` (planner/reviewer). |
| `authRequired` | string | no | `anon` \| `accountA` \| `accountB` \| `dual`. |
| `approvalPolicy` | string | no | `auto` (auto-run within allowlist) \| `approval` (human gate). |
| `scripts` | object[] | no | WASM skill scripts `{name, wasmHash?}` (hash-pinned). |
| `mcp` | string[] | no | allowed MCP server names (loopback only by default). |
| `workflow` | string | yes | markdown steps the model follows for the run. |
| `prompt` | string | yes | short system prompt (full prompt lives in `PROMPT.md`). |

Tool names are the RPC methods in `PROTOCOL.md` (`http.send`, `history.get`,
`oob.session`, `finding.create`, `bchecks.register`, …).

### Rules

- **Least privilege:** put in `tools.allow` only what the skill genuinely needs.
  Read-only skills must deny every send/mutate/scan/mcp/write tool.
- **No secrets** anywhere in the manifest or prompt.
- **Approval discipline:** state-changing or high-risk skills set
  `approvalPolicy: approval` (e.g. `scan-check-author`). Detection skills that
  only probe set `auto` but stay within their allowlist + limits.
- **Deterministic gates** (scope/budget/blocklist) apply on top of any skill;
  `approvalPolicy` only affects whether a tool call within the allowlist needs a
  human prompt.

## Worked example: `request-explainer`

File: `skills/builtin/request-explainer/skill.yaml`

```yaml
id: request-explainer
version: "1.0.0"
name: Request / Response Explainer
description: Explain and analyze a single HTTP request and response. Read-only.
triggers:
  - "explain this request"
  - "analyze this response"
  - "why did this return 403"
tools:
  allow:
    - selected.get        # read the request the user selected
    - history.get         # fetch request/response by ref
    - history.search      # minimal context lookups
    - logger.read         # recent sidecar log entries
    - payload.encode      # decode/encode params for display
  deny:
    - http.send
    - http.batch
    - http.race
    - mutate.preview
    - mutate.apply
    - oob.session
    - oob.poll
    - scan.crawl
    - scan.audit
    - scan.check.register
    - bchecks.register
    - scope.add
    - scope.remove
    - config.import
    - proxy.set_intercept
    - mcp.call
    - vault.set
    - vault.delete
    - notify.send
limits:
  requests: 50
  durationSeconds: 600
  concurrency: 1
  maxCostUsd: 0.05
modelPreference: fast
authRequired: anon
approvalPolicy: auto
workflow: |
  1. Fetch the selected request via `selected.get` (or `history.get` given a ref).
  2. Fetch the paired response body when present.
  3. Read related history entries via `history.search` for context (same host/path).
  4. Explain: method, path, parameters, auth headers used, cookies, request body shape.
  5. Explain the response: status meaning, headers of interest, body semantics.
  6. Flag anomalies: missing auth on mutating endpoint, interesting headers, redirect behavior.
  7. Never send requests. Output a structured explanation.
prompt: |
  You explain HTTP requests and responses for a bug bounty hunter. Read-only:
  never send or mutate requests. Be precise, cite headers and status codes, and
  flag security-relevant observations (auth, tokens, redirects, odd headers).
```

Design notes for this skill:

- **Read-only**: `tools.allow` contains only reads; `tools.deny` explicitly blocks
  every send/mutate/scan/write tool so a router or import cannot widen it silently.
- **Budget**: tiny (50 req / 10 min / 1 concurrency / $0.05) — it is a fast intel skill.
- **modelPreference `fast`**: triage-class work goes to the cheap model.
- **approvalPolicy `auto`**: it cannot act anyway (no send tools), so no approval burden.
- **workflow** is imperative markdown the model follows step-by-step.
- **prompt** is the short system prompt; the full prompt is duplicated in `PROMPT.md`.

File: `skills/builtin/request-explainer/PROMPT.md` — the full system prompt (see the
skill directory in this repo for the complete text).
