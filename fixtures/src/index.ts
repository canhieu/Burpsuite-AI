import { startHttpServer, type Scenario } from "./http_server.js"
import { startWsServer } from "./ws_server.js"
import { startProviderServer } from "./provider_mock.js"
import { startOauthServer } from "./oauth_mock.js"

interface ParsedArgs {
  cmd: string
  opts: Record<string, string>
}

function parseArgs(argv: string[]): ParsedArgs {
  const cmd = argv[0] ?? ""
  const opts: Record<string, string> = {}
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith("--")) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith("--")) {
      opts[key] = next
      i++
    } else {
      opts[key] = "true"
    }
  }
  return { cmd, opts }
}

function intVal(opts: Record<string, string>, key: string, envKey: string, def: number): number {
  const raw = opts[key] ?? process.env[envKey] ?? String(def)
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : def
}

const COMMANDS = ["http", "ws", "provider", "oauth"]

function usage(): string {
  return [
    "usage: node dist/index.js <cmd> [opts]",
    "",
    "commands:",
    "  http     target-app HTTP mock          --port 9000 --scenario normal|idor|sqli|xss",
    "  ws       websocket echo/chat mock       --port 9001",
    "  provider OpenAI-compatible provider mock --port 9002",
    "  oauth    OAuth device-flow mock         --port 9003",
    "",
    "env: PORT (default port), HOST (default 127.0.0.1), PROVIDER_FAIL (500|403|stream_error)",
  ].join("\n")
}

async function main(): Promise<void> {
  const { cmd, opts } = parseArgs(process.argv.slice(2))
  const host = process.env.HOST ?? "127.0.0.1"

  if (!COMMANDS.includes(cmd)) {
    console.error(usage())
    process.exit(2)
  }

  const defaultPort: Record<string, number> = { http: 9000, ws: 9001, provider: 9002, oauth: 9003 }
  const port = intVal(opts, "port", "PORT", defaultPort[cmd])

  if (cmd === "http") {
    const scenario = (opts.scenario ?? "normal") as Scenario
    const handle = await startHttpServer({ scenario, port, host })
    console.log(`[http] listening on http://${host}:${handle.port} scenario=${scenario}`)
    console.log("  routes: / /health /api/orders/:id /api/users/:id /api/search /api/redirect /api/reflect /api/echoheaders /api/big /api/slow")
  } else if (cmd === "ws") {
    const handle = await startWsServer({ port, host })
    console.log(`[ws] listening on ws://${host}:${handle.port}`)
  } else if (cmd === "provider") {
    const handle = await startProviderServer({ port, host })
    console.log(`[provider] listening on http://${host}:${handle.port} fail=${process.env.PROVIDER_FAIL ?? "none"}`)
    console.log("  endpoints: POST /v1/chat/completions POST /v1/responses GET /v1/models")
  } else {
    const handle = await startOauthServer({ port, host })
    console.log(`[oauth] listening on http://${host}:${handle.port}`)
    console.log("  endpoints: POST /oauth/device/code POST /oauth/token POST /oauth/approve")
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
