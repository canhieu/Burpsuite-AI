import { CodexOAuth } from "./codex.js"
import { ClaudeOAuth } from "./claude.js"
import type { OAuthConfig } from "./credentials.js"
import type { SidecarConfig } from "../config.js"

export type OAuthProvider = "openai" | "anthropic"

export interface AuthManager {
  hasApiKey(provider: OAuthProvider): boolean
  hasOAuthSession(provider: OAuthProvider): Promise<boolean>
  loginStart(provider: OAuthProvider, flow: "device" | "browser"): Promise<Record<string, unknown>>
  loginPoll(provider: OAuthProvider, flowId: string, deviceCode: string, interval?: number): Promise<Record<string, unknown>>
  loginCancel(provider: OAuthProvider, flowId: string): void
  logout(provider: OAuthProvider, revoke?: boolean): Promise<{ ok: boolean }>
  accessToken(provider: OAuthProvider): Promise<string | undefined>
  apiKey(provider: OAuthProvider): string | undefined
  status(provider: OAuthProvider): Promise<{ method: "api-key" | "oauth" | "none"; user?: string; expiresAt?: number }>
  providerConfig(provider: OAuthProvider): OAuthConfig | undefined
}

function oauthConfig(cfg: SidecarConfig, provider: OAuthProvider): OAuthConfig | undefined {
  const o = cfg.oauth?.[provider]
  if (!o) return undefined
  const token = o.tokenEndpoint
  const issuer = o.issuer || ""
  const clientId = o.clientId || ""
  const scope = o.scope || ""
  if (!token || !clientId) return undefined
  return {
    issuer,
    clientId,
    scope,
    tokenEndpoint: token,
    deviceEndpoint: o.deviceEndpoint,
    authorizeEndpoint: o.authorizeEndpoint,
    redirectUri: o.redirectUri,
  }
}

const deviceFlows = new Map<string, { codex: CodexOAuth; deviceCode: string; interval: number; expiresAt: number }>()

export function createAuthManager(cfg: SidecarConfig, opts?: { authPath?: string; credentialsPath?: string }): AuthManager {
  const codex = new CodexOAuth({ config: oauthConfig(cfg, "openai") ?? { issuer: "", clientId: "", scope: "", tokenEndpoint: "" }, authPath: opts?.authPath })
  const claude = new ClaudeOAuth({ config: oauthConfig(cfg, "anthropic") ?? { issuer: "", clientId: "", scope: "", tokenEndpoint: "" }, credentialsPath: opts?.credentialsPath })

  return {
    hasApiKey(provider) {
      const envName = cfg.providers[provider]?.apiKeyEnv
      return !!envName && !!process.env[envName] && process.env[envName]!.length > 0
    },
    async hasOAuthSession(provider) {
      try {
        return provider === "openai" ? await codex.hasSession() : await claude.hasSession()
      } catch {
        return false
      }
    },
    providerConfig(provider) {
      return oauthConfig(cfg, provider)
    },
    async loginStart(provider, flow) {
      if (provider === "openai") {
        if (flow !== "device") {
          return { state: "error", detail: "codex login uses the device flow; call with flow=device" }
        }
        const start = await codex.startDeviceCode()
        if (start.state !== "pending" || !start.deviceCode) return { ...start }
        deviceFlows.set(start.flowId, {
          codex,
          deviceCode: start.deviceCode,
          interval: start.interval ?? 5,
          expiresAt: Date.now() + (start.expiresIn ?? 600) * 1000,
        })
        return {
          state: "pending",
          flowId: start.flowId,
          deviceCode: start.deviceCode,
          userCode: start.userCode,
          verificationUri: start.verificationUri,
          expiresIn: start.expiresIn,
          interval: start.interval,
          deviceSupported: true,
        }
      }
      // anthropic browser flow
      if (flow !== "browser") {
        return { state: "error", detail: "claude login uses the browser flow; call with flow=browser" }
      }
      const started = await claude.startBrowserFlow()
      if (!started.authUrl) return { state: "error", detail: started.detail }
      return { state: "pending", loginId: started.loginId, authUrl: started.authUrl, flow: "browser" }
    },
    async loginPoll(provider, flowId, deviceCode, interval) {
      if (provider === "openai") {
        const flow = deviceFlows.get(flowId)
        if (!flow) return { state: "error", detail: "unknown or expired flow; restart login" }
        if (Date.now() > flow.expiresAt) {
          deviceFlows.delete(flowId)
          return { state: "error", detail: "device code expired; restart login" }
        }
        const r = await flow.codex.pollDeviceCode(flowId, deviceCode || flow.deviceCode, interval ?? flow.interval)
        if (r.state === "success") deviceFlows.delete(flowId)
        return { ...r }
      }
      return { state: "error", detail: "anthropic uses browser flow; poll via agent.hello or login.status" }
    },
    loginCancel(provider, flowId) {
      if (provider === "openai" && flowId) {
        codex.cancel(flowId)
        deviceFlows.delete(flowId)
      }
    },
    async logout(provider, revoke = true) {
      if (provider === "openai") await codex.logout(revoke)
      else await claude.logout(revoke)
      return { ok: true }
    },
    async accessToken(provider) {
      if (provider === "openai") return codex.accessToken()
      return claude.accessToken()
    },
    apiKey(provider) {
      const envName = cfg.providers[provider]?.apiKeyEnv
      if (!envName) return undefined
      const v = process.env[envName]
      return v && v.length > 0 ? v : undefined
    },
    async status(provider) {
      const key = this.apiKey(provider)
      if (key) return { method: "api-key" }
      try {
        if (await this.hasOAuthSession(provider)) {
          const tokens = provider === "openai" ? await codex.storedTokens() : await claude.storedTokens()
          return { method: "oauth", user: emailFromIdToken(tokens?.id_token), expiresAt: tokens?.expires_at }
        }
      } catch {
        /* fall through */
      }
      return { method: "none" }
    },
  }
}

function emailFromIdToken(idToken?: string): string | undefined {
  if (!idToken) return undefined
  try {
    const parts = idToken.split(".")
    if (parts.length !== 3) return undefined
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>
    return typeof claims["email"] === "string" ? (claims["email"] as string) : undefined
  } catch {
    return undefined
  }
}
