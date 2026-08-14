# Burpsuite-AI

**Multi-LLM autonomous security agent cho Burp Suite Pro** — tìm, xác minh, khai thác và báo cáo lỗ hổng trên mục tiêu bug bounty một cách bán tự động.

Hỗ trợ nhiều provider LLM (OpenAI/Codex, Anthropic Claude, DeepSeek, local Ollama/vLLM/LM Studio), đọc/phân tích toàn bộ HTTP + WebSocket history, tự gửi/replay/mutate/race request qua Burp, điều phối Burp Scanner, chạy multi-agent song song, skills, evidence + report theo chuẩn HackerOne/Bugcrowd/Intigriti/Immunefi.

> ⚠️ **Chỉ dùng cho mục tiêu đã được ủy quyền** (bug bounty program, lab, CTF). Luôn tuân scope Burp + budget + approval policy.

---

## Tính năng

- **Đa provider**: OpenAI/Codex, Anthropic, DeepSeek, Ollama/vLLM/LM Studio — đổi model không cần sửa code; per-role model (planner/executor/reviewer/fast)
- **OAuth dùng chung credential**: Codex device-code flow ↔ `~/.codex/auth.json`, Claude PKCE loopback ↔ `~/.claude/.credentials.json` — cùng 1 session với Codex CLI / Claude Code
- **Chat + context**: chat với request/response đang chọn, phân tích lịch sử, explain/analyze, context menu trong Proxy/Repeater/Target/Scanner
- **History & intel**: search/filter/inventory HTTP + WebSocket history, endpoint grouping, body slicing, redaction secret
- **Agent tool loop**: send/batch/race (single-packet style), mutate (path/query/header/body/JSON-path), Repeater/Intruder/Comparer/Organizer handoff, idempotency, cancel
- **Multi-agent**: orchestrator lập plan → chia endpoint → nhiều executor chạy song song, budget tách riêng, approval gate, pause/resume/kill
- **Autonomy an toàn**: 3 mode (manual/smart/autonomous), scope enforcement, budget (request/thời gian/concurrency/cost), blocklist platform bug bounty, redirect guard, STOP ALL
- **Khai thác**: payload bank (SQLi/XSS/SSTI/SSRF/XXE/traversal/LFI/CMDi/header-injection/upload-polyglot/JWT), WAF bypass obfuscation, crypto.jwt analyze/forge, Collaborator OOB, race driver, auth-context differential (accountA/B)
- **Scanner integration**: crawl/audit/monitor, issue ingestion, BChecks register, custom ScanCheck
- **Findings & report**: evidence-gated validation, dedup, report Markdown cho 4 nền tảng, redacted export
- **Redaction mặc định**: Authorization/Cookie/Set-Cookie/token/password luôn bị che khi gửi model remote — raw request chỉ nằm trong extension
- **Prompt-injection defense**: 3 lớp (untrusted zone, instruction guard, tool-only execution)

## Kiến trúc

```
Burp Suite Pro (Java 17, Montoya API 2026.7)
┌─────────────────────────────────────────────────┐
│  extension/ (Kotlin)                            │
│  • WS JSON-RPC server (loopback + auth token)   │
│  • Tool handlers (history/http/mutate/scan/...) │
│  • Policy engine (scope/budget/approval/redact) │
│  • Agent tab + context menu                     │
└────────────────────┬────────────────────────────┘
                     │ JSON-RPC 2.0 over WebSocket
┌────────────────────▼────────────────────────────┐
│  sidecar/ (Node/TS)                             │
│  • Provider adapters (OpenAI/Anthropic/DeepSeek/│
│    Ollama) + OAuth (Codex/Claude)               │
│  • Multi-agent engine (orchestrator+executors)  │
│  • Exploitation (payloads/crypto/OOB/race)      │
│  • Skills + findings/evidence/report            │
│  • SQLite store (refs & summaries, no secrets)  │
└─────────────────────────────────────────────────┘
```

- **Extension giữ toàn quyền Burp** — sidecar không gọi thẳng mục tiêu; mọi request đi qua tool → extension kiểm tra policy → Montoya API
- Request agent gửi xuất hiện trong Logger + Site Map (Montoya 2026.7 **không có** `localProxy()`, nên không vào Proxy HTTP history — xem `STATUS.md`)

## Quickstart

Xem đầy đủ: [`docs/quickstart.md`](docs/quickstart.md)

```bash
# 1. Fixtures (mock target + providers + oauth)
cd fixtures && npm ci && npm run build
bash ../scripts/start-fixtures.sh        # http:9000 ws:9001 provider:9002 oauth:9003

# 2. Sidecar
cd sidecar && npm ci && npm run build
cp config.example.json config.json       # sửa authToken
CONFIG_PATH=config.json npm start

# 3. Kiểm tra tích hợp
node scripts/integration-smoke.mjs       # 25 checks

# 4. Extension → Burp Pro
cd /mnt/e/lab/burp && ./gradlew :extension:shadowJar
# load extension/build/libs/extension-0.1.0.jar trong Burp → Extensions
```

### Cấu hình provider

API key chỉ từ environment variables — không bao giờ lưu vào project/SQLite/log:

```bash
export OPENAI_API_KEY=sk-...        # OpenAI / Codex (API key)
export ANTHROPIC_API_KEY=sk-ant-... # Claude
export DEEPSEEK_API_KEY=sk-...      # DeepSeek
```

Hoặc OAuth (dùng subscription account như Codex CLI / Claude Code):

```bash
# Codex: device flow, token vào ~/.codex/auth.json (dùng chung Codex CLI)
curl -X POST ws://127.0.0.1:8570/ ...  # hoặc qua UI: Settings → Providers → Log in
```

Local model: chỉnh `providers.ollama.baseUrl` → `http://127.0.0.1:11434/v1`.

## Cấu trúc repo

```
burp-agent/
├── extension/      Kotlin Burp extension (Montoya API)
├── sidecar/        Node/TS agent core (providers, oauth, multi-agent, payloads)
├── protocol/       rpc.schema.json + PROTOCOL.md (contract JSON-RPC)
├── skills/builtin/ 12 skill manifests (YAML + PROMPT.md)
├── fixtures/       mock target HTTP/WS + provider-mock + oauth-mock
├── scripts/        dev/test/smoke scripts
├── docs/           architecture, security, run-lifecycle, skill-authoring...
├── PLAN.md         master plan (M0–M10)
├── PROTOCOL.md     RPC method reference
└── STATUS.md       trạng thái triển khai + hạn chế API
```

## Skills

12 built-in skills (`skills/builtin/`), mỗi skill = `skill.yaml` (permissions, budget, approval policy, workflow) + `PROMPT.md`:

`request-explainer` · `history-triage` · `attack-surface-map` · `sqli-hunter` · `xss-hunter` · `ssrf-hunter` · `idor-candidate` · `auth-bypass-check` · `race-hunter` · `scan-check-author` · `finding-validator` · `report-writer`

Viết skill riêng: [`docs/skill-authoring.md`](docs/skill-authoring.md).

## Test

```bash
./gradlew :extension:test :extension:shadowJar   # extension 38 tests + fat jar
cd sidecar && npm test && npm run test:contract  # 71 + 2
cd fixtures && npm test                          # 31
node scripts/integration-smoke.mjs               # 25 end-to-end checks
```

## Bảo mật

- Secret bị redact ở biên giới extension — model remote không thấy cookie/token thật
- API key chỉ từ env; token OAuth nằm trong `auth.json` / `.credentials.json` (0600)
- Autonomous luôn trong scope + budget; approval cho hành động rủi ro (sửa scope, import config, toggle intercept, script ngoài sandbox)
- Prompt-injection: response body là untrusted data, không bao giờ vào system prompt

Chi tiết: [`docs/security.md`](docs/security.md).

## So sánh với Burp AI / Burp AT

Bảng đầy đủ trong [`docs/burpai-comparison.md`](docs/burpai-comparison.md) — tóm tắt: phủ toàn bộ Burp AI/AT (chat, history context, local LLM, AI-authored BChecks, live plan view) + thêm đa-provider, OAuth dùng chung, open skills, toàn quyền Burp tools.

## Trạng thái & hạn chế

Xem [`STATUS.md`](STATUS.md). Còn stub: WASM skill sandbox, MCP integration, OS keychain, UI login modal. Hạn chế API: Montoya 2026.7 không có `localProxy()` (request agent không vào Proxy history).

## Roadmap

Theo [`PLAN.md`](PLAN.md) — M0–M10 đã first-pass xong; OAuth + multi-agent engine + payload engine đã hoạt động.
