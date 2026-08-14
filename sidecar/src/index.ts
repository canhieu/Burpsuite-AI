import { createServer } from "node:http"
import { createLogger, now } from "./util.js"
import { loadConfig } from "./config.js"
import { createStore } from "./store.js"
import { createProviderRegistry, type ProviderStatus } from "./providers.js"
import { RpcServer } from "./rpc.js"
import type { Handler } from "./handlers/types.js"
import type { Services } from "./handlers/types.js"
import { lifecycleHandlers } from "./handlers/lifecycle.js"
import { authHandlers } from "./handlers/auth.js"
import { settingsHandlers } from "./handlers/settings.js"
import { configHandlers } from "./handlers/config.js"
import { modelsHandlers } from "./handlers/models.js"
import { payloadHandlers } from "./handlers/payloads.js"
import { oobHandlers } from "./handlers/oob.js"
import { notifyHandlers } from "./handlers/notify.js"
import { vaultHandlers } from "./handlers/vault.js"
import { mcpHandlers, sandboxHandlers } from "./handlers/mcp.js"
import { findingHandlers } from "./handlers/findings.js"
import { evidenceHandlers } from "./handlers/evidence.js"
import { reportHandlers } from "./handlers/report.js"
import { chatHandlers } from "./handlers/chat.js"
import { registerRunHandlers } from "./handlers/run-handler.js"
import { createAuthManager } from "./auth/manager.js"
import { initAuthManager } from "./handlers/auth.js"

export const SIDECAR_VERSION = "0.1.0"

export async function buildSidecar(config = loadConfig()) {
  const logger = createLogger(config.logging.level, "sidecar")
  const log = (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => {
    if (level === "error") logger.error(msg, meta)
    else if (level === "warn") logger.warn(msg, meta)
    else if (level === "debug") logger.debug(msg, meta)
    else logger.info(msg, meta)
  }

  const store = await createStore(config.dataDir, (msg) => log("warn", msg))
  log("info", `store backend: ${store.backend}`)
  const auth = createAuthManager(config)
  initAuthManager(auth)
  let registry = await createProviderRegistry(config, {
    resolveToken: async (provider) => {
      try {
        if (auth.hasApiKey(provider as "openai" | "anthropic")) return undefined
        return await auth.accessToken(provider as "openai" | "anthropic")
      } catch {
        return undefined
      }
    },
  })

  const services: Services = {
    config,
    store,
    registry,
    startTime: now(),
    sidecarVersion: SIDECAR_VERSION,
    log,
    getProviderStatuses: async (): Promise<ProviderStatus[]> => {
      try {
        return await registry.statuses()
      } catch {
        return []
      }
    },
    rebuildRegistry: async () => {
      const rebuilt = await createProviderRegistry(config, {
        resolveToken: async (provider) => {
          try {
            if (auth.hasApiKey(provider as "openai" | "anthropic")) return undefined
            return await auth.accessToken(provider as "openai" | "anthropic")
          } catch {
            return undefined
          }
        },
      })
      registry = rebuilt
      services.registry = rebuilt
    },
  }

  const handlers = new Map<string, Handler>()
  for (const group of [
    lifecycleHandlers(),
    authHandlers(),
    settingsHandlers(),
    configHandlers(),
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
  ]) {
    for (const [method, handler] of Object.entries(group)) handlers.set(method, handler)
  }

  const server = createServer()
  const rpc = new RpcServer(config, services, logger, handlers, SIDECAR_VERSION)
  rpc.attach(server)

  const { group: runHandlers } = registerRunHandlers(rpc, { services, handlers })
  for (const [method, handler] of Object.entries(runHandlers)) handlers.set(method, handler)

  return { config, services, store, registry, server, rpc, handlers }
}

async function main(): Promise<void> {
  const { config, server, rpc, services } = await buildSidecar()
  const host = config.host
  const port = config.port

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => resolve())
  })

  services.log("info", `sidecar listening on ws://${host}:${port}`)
  services.log("info", `enabled providers: ${services.registry.all().map((p) => p.provider).join(", ") || "none"}`)
  services.log("info", `auth: ${config.authToken === "change-me" ? "default token (set CONFIG_PATH)" : "configured"}`)

  // If spawned by the Burp extension, dial back to it (the extension is the WS server).
  rpc.connectToExtension()

  const shutdown = (signal: string) => {
    services.log("info", `received ${signal}, shutting down`)
    rpc.stop()
    rpc.close()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT"))
}

import { pathToFileURL } from "node:url"

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
