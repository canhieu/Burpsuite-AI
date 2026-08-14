import { createServer } from "node:http"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { WebSocket } from "ws"
import { loadConfig, type SidecarConfig } from "../src/config.js"
import { createStore, type Store } from "../src/store.js"
import { createProviderRegistry, type ProviderRegistry } from "../src/providers.js"
import { RpcServer } from "../src/rpc.js"
import type { Handler, Services } from "../src/handlers/types.js"
import { createLogger } from "../src/util.js"
import { lifecycleHandlers } from "../src/handlers/lifecycle.js"
import { authHandlers } from "../src/handlers/auth.js"
import { settingsHandlers } from "../src/handlers/settings.js"
import { modelsHandlers } from "../src/handlers/models.js"
import { payloadHandlers } from "../src/handlers/payloads.js"
import { oobHandlers } from "../src/handlers/oob.js"
import { notifyHandlers } from "../src/handlers/notify.js"
import { vaultHandlers } from "../src/handlers/vault.js"
import { mcpHandlers, sandboxHandlers } from "../src/handlers/mcp.js"
import { findingHandlers } from "../src/handlers/findings.js"
import { evidenceHandlers } from "../src/handlers/evidence.js"
import { reportHandlers } from "../src/handlers/report.js"
import { chatHandlers } from "../src/handlers/chat.js"

const REAL_GROUPS = [
  lifecycleHandlers(),
  authHandlers(),
  settingsHandlers(),
  modelsHandlers(),
  payloadHandlers(),
  oobHandlers(),
  notifyHandlers(),
  vaultHandlers(),
  mcpHandlers(),
  sandboxHandlers(),
  findingHandlers(),
  evidenceHandlers(),
  reportHandlers(),
  chatHandlers(),
]

export function makeConfig(): SidecarConfig {
  const cfg = loadConfig()
  cfg.host = "127.0.0.1"
  cfg.port = 0
  cfg.authToken = "test-token"
  cfg.dataDir = mkdtempSync(join(tmpdir(), "sidecar-test-"))
  for (const p of Object.values(cfg.providers)) p.enabled = false
  return cfg
}

export interface TestServer {
  url: string
  port: number
  server: ReturnType<typeof createServer>
  rpc: RpcServer
  store: Store
  registry: ProviderRegistry
  config: SidecarConfig
  handlers: Map<string, Handler>
  services: Services
  close(): Promise<void>
}

export async function startTestServer(extraHandlers?: Record<string, Handler>): Promise<TestServer> {
  const config = makeConfig()
  const store = createStore(config.dataDir)
  const registry = await createProviderRegistry(config)
  const logger = createLogger("error", "test")
  const services: Services = {
    config,
    store,
    registry,
    startTime: Date.now(),
    sidecarVersion: "0.1.0",
    log: () => {},
    getProviderStatuses: async () => [],
  }
  const handlers = new Map<string, Handler>()
  for (const group of REAL_GROUPS) {
    for (const [method, handler] of Object.entries(group)) handlers.set(method, handler)
  }
  for (const [method, handler] of Object.entries(extraHandlers ?? {})) handlers.set(method, handler)
  const server = createServer()
  const rpc = new RpcServer(config, services, logger, handlers, "0.1.0")
  rpc.attach(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const port = (server.address() as AddressInfo).port
  const url = `ws://127.0.0.1:${port}`
  return {
    url,
    port,
    server,
    rpc,
    store,
    registry,
    config,
    handlers,
    services,
    close: async () => {
      rpc.close()
      store.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

export interface TestClient {
  ws: WebSocket
  next(): Promise<unknown>
  close(): Promise<void>
}

export function connectClient(url: string, token = "test-token"): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const queue: unknown[] = []
    const waiters: Array<(msg: unknown) => void> = []
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString())
      const w = waiters.shift()
      if (w) w(msg)
      else queue.push(msg)
    })
    ws.on("error", reject)
    ws.on("open", () => {
      resolve({
        ws,
        next: () => {
          if (queue.length) return Promise.resolve(queue.shift())
          return new Promise((res) => waiters.push(res))
        },
        close: () =>
          new Promise<void>((res) => {
            ws.close()
            ws.on("close", () => res())
          }),
      })
    })
    void token
  })
}

export function sendRequest(ws: WebSocket, id: number | string, method: string, params?: Record<string, unknown>): void {
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }))
}
