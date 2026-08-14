# BurpAgent RPC Protocol Reference

Transport: JSON-RPC 2.0 over WebSocket, loopback only. Extension = client, sidecar = server.
Sidecar auto-spawned by extension. After connect, client MUST send `handshake.hello` notification
with `{projectId, nonce, token}`. Server responds `agent.hello` result `{ok, sidecarVersion}` or
closes with error `401`.

## Conventions
- Errors: `{code, message}` — code `-32600` invalid request, `401` auth failed, `404` not found,
  `429` budget exceeded, `500` internal. Policy-blocked sends return `403` with `data.reason`.
- All HTTP request/response bodies returned to the sidecar MUST be REDACTED (secrets masked)
  unless a `redacted:false` flag is explicitly passed (local providers only).
- Mutating tools accept optional `idempotencyKey`; server MUST return the cached result for a
  repeated key.

## Methods

### Lifecycle / health
- `handshake.hello` (notification) `{projectId, nonce, token}` → `agent.hello` `{ok, version}`
- `agent.ping` → `{pong, version, uptimeMs}`
- `agent.hello` → `{ok, version, providerStatus: ProviderStatus[]}`

### Providers & auth
- `auth.status` → `{providers: ProviderStatus[]}`
- `auth.login.start` `{provider, flow: "device"|"browser", apiKey?}` → `{userCode?, verificationUri?, port?, expiresIn}`
- `auth.login.poll` `{provider}` → `{state: "pending"|"success"|"expired"|"error", detail?}`
- `auth.login.cancel` `{provider}`
- `auth.logout` `{provider, revoke?}`
- `settings.get` `{paths?: string[]}` → `{settings}`
- `settings.set` `{patch}` → `{settings}`
- `models.list` `{provider}` → `{models: ModelInfo[]}`
- `models.resolve` `{alias}` → `{model: ModelInfo}`

### Chat / agent
- `agent.chat` (streaming) `{messages, model?, provider?, skill?, context?: {messageRefs?: MessageRef[]}, stream?: bool}` → events `agent.event` `{type:"text"|"tool_call"|"tool_result"|"done"|"error", data}` then `agent.chat` result `{done:true}`
- `agent.run.start` `{task, skill?, mode?: "manual"|"smart"|"autonomous", scope?: string[], budget?: {requests, durationSeconds, concurrency, maxCostUsd}, models?: {planner?, executor?, reviewer?}, executors?: number, seedRefs?: MessageRef[]}` → `{runId}`
- `agent.run.pause` `{runId}` · `agent.run.resume` `{runId}` · `agent.run.cancel` `{runId}`
- `agent.run.kill` (all) → kills orchestrator + executors + owned scan tasks
- `agent.run.status` `{runId}` → `RunStatus`
- events: `run.progress` `{runId, step, done, message}`, `tool.call` `{runId, toolCall}`, `approval.requested` `{runId, request: ApprovalRequest}`

### History
- `history.search` `{host?, path?, method?, status?, mime?, inScopeOnly?, since?, text?, limit?, offset?}` → `{items: Array<{ref: MessageRef, method, host, path, status, mime, contentType, timestamp, size}>}`
- `history.get` `{ref: MessageRef, redacted?: bool}` → `{request: RedactedHttpMessage, response?: RedactedHttpMessage, annotations?, timing?}`
- `history.inventory` `{host?, inScopeOnly?}` → `{endpoints: Array<{method, host, routeShape, params, statuses, mime, count, authContexts}>}`
- `history.websockets` `{host?}` → `{connections: Array<{wsId, url, messages}>}`

### HTTP
- `http.send` `{ref?: MessageRef, request?: RedactedHttpMessage, via?: "proxy"|"direct", httpService?, mutate?: Mutation, timeoutMs?, idempotencyKey?}` → `{ref, statusCode, responseStartLine, headers, body, bodyTruncated, timingMs, via}` (result request/response refs recorded)
- `http.batch` `{requests: Array<http.send params>, concurrency?, ratePerSecond?}` → `{results: [...]}`
- `http.race` `{base: http.send params, count, staggerMs?, idempotencyKey}` → `{results: [...], distinctResponses: number}`
- `mutate.preview` `{ref, mutation}` → `{request: RedactedHttpMessage}`
- `mutate.apply` = `http.send` with `mutate`

### Tools / handoff (extension-side)
- `tool.repeater.send` `{request: RedactedHttpMessage, name?}`
- `tool.intruder.send` `{request: RedactedHttpMessage, name?, template?: {positions: number[]}}`
- `tool.comparer.send` `{items: RedactedHttpMessage[]}`
- `tool.organizer.send` `{ref|request: RedactedHttpMessage, name?}`
- `tool.organizer.read` → `{items}`
- `site_map.list` `{host?, filter?}` → `{items}`
- `site_map.add` `{ref|request, response?}` (approval)
- `site_map.issues` → `{issues}`
- `scope.get` → `{scope: string[]}` · `scope.add` `{urls}` (approval) · `scope.remove` `{urls}` (approval)
- `proxy.set_intercept` `{enabled}` (approval)
- `config.export` `{paths?}` → `{json}` · `config.import` `{json}` (approval)
- `task_engine.pause` · `task_engine.resume`
- `selected.get` → `{refs: MessageRef[], request, response}`
- `logger.read` `{since?, host?}` → `{entries}`

### Payloads / crypto (sidecar-local)
- `payload.encode` `{algorithm: "url"|"base64"|"hex"|"json"|"html"|"unix_time"|"unicode"|"double_url", input}` → `{output}`
- `payload.obfuscate` `{technique, input}` → `{outputs: string[]}`
- `payload.build` `{class: "sqli"|"xss"|"ssti"|"ssrf"|"xxe"|"traversal"|"lfi"|"cmdi"|"header_injection"|"upload_polyglot"|"jwt_tamper", template, context?}` → `{payloads: string[]}`
- `crypto.jwt.analyze` `{token}` → `{header, payload, alg, possibleIssues: string[]}`
- `crypto.jwt.forge` `{token, mutations: {alg?, claims?}}` → `{tokens: string[]}`
- `oob.session` → `{clientId, secretKey, payloads: {dns, http, https}, pollToken}`
- `oob.poll` `{clientId}` → `{interactions: Array<{type, protocol, ip, time, data}>}`
- `websocket.create` `{upgradeRef|request, payloads?}` → `{wsId}`
- `websocket.send` `{wsId, payload, opcode?}` → `{result}`
- `websocket.close` `{wsId}`
- `auth.switch_context` `{context: "accountA"|"accountB"|"anon"}` → `{active: context}`

### Scanning (M7)
- `scan.crawl` `{url, config?}` → `{taskId}` · `scan.audit` `{urls: string[], config?}` → `{taskId}`
- `scan.add_requests` `{taskId, refs}` · `scan.task_status` `{taskId}` → `{requests, errors, issues, status}`
- `scan.stop` `{taskId}` · `scan.report` `{taskId|issueIds, format: "html"|"xml", path}` (approval for path write)
- `bchecks.register` `{definition: string, name?}` → `{checkId}` (approval)
- `scan.check.register` `{kind: "active"|"passive", name, logic}` → `{checkId}` (approval)

### Extensions (M6)
- `mcp.call` `{server, tool, arguments}` → `{result}` (non-loopback servers = approval)
- `mcp.servers.list` → `{servers}` · `mcp.server.add/remove` `{config}` (approval)
- `sandbox.run` `{scriptHash, entry, args, capabilities?}` → `{result}` (WASM, no FS/network)
- `vault.set` `{namespace, key, value}` → `{stored:true}` (OS keychain)
- `vault.get` `{namespace, key}` → `{value}` · `vault.delete` `{namespace, key}`
- `notify.send` `{channel: "telegram"|"webhook", event, payload}` → `{sent:true}`

### Findings / evidence (M9)
- `finding.create` `{finding: Finding}` → `{id}` · `finding.update` `{finding}`
- `finding.list` `{status?, program?}` → `{findings: Finding[]}`
- `finding.validate` `{id}` → `{verdict, reasons: string[]}` (deterministic gates)
- `evidence.pin` `{findingId, evidence}` → `{id}`
- `evidence.export` `{findingId, format: "har"|"markdown"|"json", redacted?: bool}` → `{content}`
- `report.generate` `{program: "hackerone"|"bugcrowd"|"intigriti"|"immunefi", findingIds, outPath?}` → `{markdown}` (approval for outPath)

## Event notifications (server→client)
- `agent.event` `{type: "text"|"tool_call"|"tool_result"|"done"|"error", data}`
- `run.progress` `{runId, step, done, message}`
- `tool.call` `{runId, toolCall}`
- `finding.updated` `{finding}`
- `approval.requested` `{runId, request}` — client MUST reply `agent.approve` `{requestId, approved}`
- `auth.status.changed` `{providers}`
- `budget.warning` `{runId, metric, value, cap}`
