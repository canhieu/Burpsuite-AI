import { createAuthManager, type AuthManager } from "../auth/manager.js"
import type { HandlerGroup } from "./types.js"

let manager: AuthManager | null = null

function authManager(): AuthManager {
  // Manager is recreated per-call against the loaded config; lazy singleton to preserve device flows.
  return manager!
}

export function initAuthManager(m: AuthManager): void {
  manager = m
}

function providerOf(raw: unknown): "openai" | "anthropic" {
  const p = typeof raw === "string" ? raw : (raw as { provider?: string })?.provider
  if (p === "openai" || p === "anthropic") return p
  throw Object.assign(new Error("auth provider must be 'openai' or 'anthropic'"), { code: -32602 })
}

export function authHandlers(): HandlerGroup {
  return {
    "auth.status": async (_p, _c, services) => {
      const m = manager ?? createAuthManager(services.config)
      const openai = await m.status("openai")
      const anthropic = await m.status("anthropic")
      const deepseekKey = !!process.env["DEEPSEEK_API_KEY"]
      return {
        providers: [
          { provider: "openai", ...openai },
          { provider: "anthropic", ...anthropic },
          { provider: "deepseek", method: deepseekKey ? "api-key" : "none" },
        ],
      }
    },
    "auth.login.start": async (params, _c, services) => {
      const m = manager ?? createAuthManager(services.config)
      const provider = providerOf(params["provider"])
      const flow = params["flow"] === "browser" ? "browser" : "device"
      return m.loginStart(provider, flow)
    },
    "auth.login.poll": async (params, _c, services) => {
      const m = manager ?? createAuthManager(services.config)
      const provider = providerOf(params["provider"])
      const flowId = typeof params["flowId"] === "string" ? params["flowId"] : ""
      const deviceCode = typeof params["deviceCode"] === "string" ? params["deviceCode"] : ""
      const interval = typeof params["interval"] === "number" ? params["interval"] : undefined
      return m.loginPoll(provider, flowId, deviceCode, interval)
    },
    "auth.login.cancel": (params, _c, services) => {
      const m = manager ?? createAuthManager(services.config)
      const provider = providerOf(params["provider"])
      const flowId = typeof params["flowId"] === "string" ? params["flowId"] : ""
      m.loginCancel(provider, flowId)
      return { ok: true }
    },
    "auth.logout": async (params, _c, services) => {
      const m = manager ?? createAuthManager(services.config)
      const provider = providerOf(params["provider"])
      const revoke = params["revoke"] !== false
      return m.logout(provider, revoke)
    },
    "auth.switch_context": async (params) => {
      const ctx = params["context"]
      if (ctx !== "accountA" && ctx !== "accountB" && ctx !== "anon") {
        throw Object.assign(new Error("context must be accountA | accountB | anon"), { code: -32602 })
      }
      activeAuthContext = ctx
      return { active: ctx }
    },
    "auth.context": () => ({ active: activeAuthContext }),
  }
}

let activeAuthContext: "accountA" | "accountB" | "anon" = "anon"
