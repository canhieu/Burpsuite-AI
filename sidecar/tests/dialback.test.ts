import { describe, it, expect } from "vitest"
import { WebSocketServer } from "ws"
import { spawn } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("extension dial-back (sidecar connects OUT to extension WS server)", () => {
  it("sidecar dials extension, handshakes, and responds to extension requests", async () => {
    const token = "ext-token-abc"
    const nonce = "nonce-x"
    const projectId = "proj-1"

    // 1. mock extension WS server (like RpcServer.kt)
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 })
    await new Promise<void>((res) => wss.on("listening", () => res()))
    const extPort = (wss.address() as { port: number }).port

    let handshakeOk = false
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("extension never got a response")), 20000)
      wss.on("connection", (ws) => {
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString())
          if (msg.method === "handshake.hello") {
            const p = msg.params
            if (p.token === token && p.nonce === nonce && p.projectId === projectId) {
              handshakeOk = true
              // accept handshake, then send a request to the sidecar (extension -> sidecar direction)
              ws.send(JSON.stringify({ jsonrpc: "2.0", method: "agent.hello", params: { ok: true, version: "test-ext", providerStatus: [] } }))
              setTimeout(() => {
                ws.send(JSON.stringify({ jsonrpc: "2.0", id: 77, method: "agent.ping" }))
              }, 300)
            } else {
              ws.send(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: 401, message: "auth failed" } }))
              ws.close()
            }
          } else if (msg.id === 77) {
            clearTimeout(timer)
            resolve(msg.result ?? msg.error)
          }
        })
      })
    })

    // 2. spawn the real sidecar with dial-back env
    const dataDir = mkdtempSync(join(tmpdir(), "burp-dialback-"))
    const cfgPath = join(dataDir, "config.json")
    writeFileSync(cfgPath, JSON.stringify({
      host: "127.0.0.1", port: 0, authToken: "change-me", dataDir: join(dataDir, "data"),
      providers: { openai: { enabled: false, baseUrl: "http://x" }, anthropic: { enabled: false, baseUrl: "http://x" }, deepseek: { enabled: false, baseUrl: "http://x" }, ollama: { enabled: false, baseUrl: "http://x" } },
      localOnly: true, notifications: {}, logging: { level: "error", redactSecrets: true },
      models: { roles: { planner: { provider: "openai", model: "m" }, executor: { provider: "openai", model: "m" }, reviewer: { provider: "openai", model: "m" }, fast: { provider: "openai", model: "m" } } },
    }, null, 2))

    const sidecar = spawn("node", ["dist/index.js"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        BURP_AGENT_WS_URL: `ws://127.0.0.1:${extPort}`,
        BURP_AGENT_TOKEN: token,
        BURP_AGENT_NONCE: nonce,
        BURP_AGENT_PROJECT_ID: projectId,
        CONFIG_PATH: cfgPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let sidecarErr = ""
    sidecar.stderr.on("data", (d) => (sidecarErr += d))

    try {
      const reply = await result
      expect(handshakeOk).toBe(true)
      expect((reply as { pong?: boolean }).pong).toBe(true)
    } catch (e) {
      throw new Error(`${(e as Error).message}\nsidecar stderr: ${sidecarErr}`)
    } finally {
      sidecar.kill("SIGKILL")
      wss.close()
    }
  }, 30000)
})
