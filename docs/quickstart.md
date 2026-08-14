# Quickstart

## Prerequisites

- Node.js >= 20 (tested 20.20.1) + npm.
- Burp Suite Pro 2026.x (Java 17, Montoya API 2026.7) for the extension.
- Gradle Wrapper committed in the repo — no local Gradle install required.

## 1. Start the sidecar

```bash
cd sidecar
npm ci
npm run dev        # tsx src/index.ts — starts WS RPC server (default 127.0.0.1:8570)
```

Configure providers in `config.example.json` → copy to `config.json`. API keys are
read from env vars only (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`).
For local-only use, point `providers.*.baseUrl` at `http://127.0.0.1:11434/v1` (Ollama).

## 2. Start the fixtures

```bash
cd fixtures
npm ci
npm run build

# target-app mock (vulnerable routes)
npm run start-http                          # 127.0.0.1:9000, scenario normal

# websocket mock
npm run start-ws                            # 127.0.0.1:9001

# OpenAI-compatible provider mock
npm run start                               # node dist/index.js  (provider defaults)

# OAuth device-flow mock
node dist/index.js oauth --port 9003
```

Or all at once with the script:

```bash
scripts/start-fixtures.sh
```

Routes for the http mock (scenario `normal`): `/`, `/health`,
`POST /api/orders/:id`, `GET /api/users/:id`, `POST /api/search?q=`,
`GET /api/redirect`, `GET /api/reflect?x=`, `GET /api/echoheaders`,
`GET /api/big`, `GET /api/slow`. Scenario switch via `--scenario idor|sqli|xss|normal`
enables only the matching route family.

## 3. Load the extension into Burp

```bash
cd extension
./gradlew shadowJar
```

1. Burp → Extensions → Add → choose `extension/build/libs/*-all.jar`.
2. BurpBridge registers; it auto-spawns the sidecar (Windows exe → WSL node →
   system node). The sidecar connects over loopback WS and completes the
   `handshake.hello` exchange.
3. Check the Agent tab → Settings → Sidecar connection shows `connected`.

If the sidecar is already running with `npm run dev`, the extension may also
connect to it (verify the expected port in extension settings).

## 4. First chat

1. Make a request through Burp's proxy (or Repeater).
2. Right-click it → **Ask Agent / Explain request/response**.
3. In the Agent tab → Chat, confirm the model answered.
4. Run a skill: Skills view → load `request-explainer` → run on the selected request.
5. For an autonomous test: Runs view → Start → pick a skill (e.g. `sqli-hunter`),
   confirm scope and budget, watch the live plan. **STOP ALL** is always visible.

## Sanity check

```bash
cd fixtures && npm test          # 31 tests against all mocks
cd fixtures && npm run validate-skills
```
