import { createCredentialFile, type AuthTokens, codexAuthPath, normalizeTokenResponse, type OAuthConfig } from "./credentials.js"

function expiresInFrom(body: Record<string, unknown>): number {
  const v = body["expires_in"]
  if (typeof v === "number") return v
  if (typeof v === "string" && v.trim() !== "") return parseInt(v, 10) || 600
  const at = body["expires_at"]
  if (typeof at === "string") {
    const t = Date.parse(at)
    if (!Number.isNaN(t)) return Math.max(1, Math.round((t - Date.now()) / 1000))
  }
  return 600
}

/**
 * Codex CLI-compatible OAuth for ChatGPT-account auth.
 * Implements the device-code flow (primary) used by `codex login --device-auth`,
 * stores tokens in the SAME ~/.codex/auth.json that Codex CLI reads/writes
 * (`AuthDotJson` schema), so both tools share one session.
 * Falls back to nothing if device flow is server-gated (returns unsupported).
 */
export interface CodexOAuthOptions {
  config: OAuthConfig
  /** Path override for tests. Defaults to ~/.codex/auth.json */
  authPath?: string
  fetchImpl?: typeof fetch
  sleepMs?: (ms: number) => Promise<void>
}

export interface DeviceCodeResult {
  state: "pending" | "success" | "error"
  userCode?: string
  verificationUri?: string
  deviceCode?: string
  interval?: number
  expiresIn?: number
  detail?: string
  accessToken?: string
  refreshToken?: string
}

const CODE = new Map<string, { cancel: boolean }>()

export class CodexOAuth {
  private creds: ReturnType<typeof createCredentialFile>
  private sleepMs: (ms: number) => Promise<void>
  private fetchImpl: typeof fetch

  constructor(private opts: CodexOAuthOptions) {
    this.creds = createCredentialFile(this.opts.authPath ?? codexAuthPath())
    this.sleepMs = opts.sleepMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
  }

  private cfg(): OAuthConfig {
    return this.opts.config
  }

  /** True if a valid (or refreshable) ChatGPT session is stored in ~/.codex/auth.json */
  async hasSession(): Promise<boolean> {
    const auth = await this.creds.load()
    if (!auth) return false
    if (typeof auth["OPENAI_API_KEY"] === "string" && auth["OPENAI_API_KEY"]) return true
    const tokens = auth["tokens"]
    return !!(tokens && typeof tokens === "object" && (tokens as AuthTokens).access_token)
  }

  /** api-key in auth.json or OPENAI_API_KEY env? */
  async apiKey(): Promise<string | undefined> {
    const auth = await this.creds.load()
    if (auth && typeof auth["OPENAI_API_KEY"] === "string" && auth["OPENAI_API_KEY"]) {
      return auth["OPENAI_API_KEY"] as string
    }
    const env = process.env["OPENAI_API_KEY"]
    return env || undefined
  }

  async storedTokens(): Promise<AuthTokens | undefined> {
    const auth = await this.creds.load()
    if (!auth || typeof auth["tokens"] !== "object" || !auth["tokens"]) return undefined
    return auth["tokens"] as AuthTokens
  }

  /**
   * Start device-code flow. Returns state pending with user code + URI to show the user.
   * The returned promise RESOLVES on first poll only to hand the flow handle to the caller;
   * use startDeviceCode + pollDeviceCode for a poll loop, or runDeviceFlow for the whole thing.
   */
  async startDeviceCode(): Promise<{ flowId: string } & DeviceCodeResult> {
    const cfg = this.cfg()
    if (!cfg.deviceEndpoint) return { flowId: "", state: "error", detail: "device flow not configured" }
    const flowId = crypto.randomUUID()
    CODE.set(flowId, { cancel: false })
    try {
      const res = await this.fetchImpl(cfg.deviceEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: cfg.clientId }),
      })
      if (!res.ok) {
        return { flowId, state: "error", detail: `device code request failed: HTTP ${res.status}` }
      }
      const body = (await res.json()) as Record<string, unknown>
      const userCode = (typeof body["user_code"] === "string" ? body["user_code"] : typeof body["usercode"] === "string" ? body["usercode"] : undefined) as string | undefined
      const deviceCode = (typeof body["device_auth_id"] === "string" ? body["device_auth_id"] : typeof body["device_code"] === "string" ? body["device_code"] : undefined) as string | undefined
      const intervalRaw = body["interval"]
      const interval = typeof intervalRaw === "number" ? intervalRaw : parseInt(String(intervalRaw ?? "5"), 10) || 5
      const expiresIn = expiresInFrom(body)
      const verificationUri = ((cfg.verificationUri ?? cfg.issuer ?? "").trim() || body["verification_uri"]) as string | undefined
      if (!userCode || !deviceCode) return { flowId, state: "error", detail: "malformed device code response" }
      return { flowId, state: "pending", userCode, verificationUri, deviceCode, interval, expiresIn }
    } catch (e) {
      return { flowId, state: "error", detail: (e as Error).message }
    }
  }

  /**
   * Poll token endpoint for a started device flow. `deviceCode` is the device_auth_id;
   * the real ChatGPT flow returns an authorization_code + PKCE, which we then exchange.
   */
  async pollDeviceCode(flowId: string, deviceCode: string, interval = 5, userCode = ""): Promise<DeviceCodeResult> {
    const gate = CODE.get(flowId)
    if (!gate) return { state: "error", detail: "unknown flow" }
    const cfg = this.cfg()
    try {
      const tokenEndpoint = cfg.deviceTokenEndpoint ?? cfg.tokenEndpoint
      const useDeviceApi = !!cfg.deviceTokenEndpoint
      const body: Record<string, unknown> = useDeviceApi
        ? { device_auth_id: deviceCode, user_code: userCode }
        : {
            client_id: cfg.clientId,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: deviceCode,
          }
      const res = await this.fetchImpl(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const rawBody = (await res.json()) as Record<string, unknown>
      if (res.ok) {
        if (useDeviceApi) {
          return await this.exchangeAuthorizationCode(flowId, cfg, rawBody)
        }
        const tokens = normalizeTokenResponse(rawBody)
        await this.writeTokens(tokens)
        CODE.delete(flowId)
        return { state: "success", accessToken: tokens.access_token, refreshToken: tokens.refresh_token }
      }
      const err = typeof rawBody["error"] === "string" ? rawBody["error"] : (rawBody["error"] as { code?: string })?.code ?? ""
      if (useDeviceApi && (res.status === 403 || res.status === 404)) {
        await this.sleepMs(interval * 1000)
        return { state: "pending", userCode, interval }
      }
      if (err === "authorization_pending" || err === "slow_down" || err === "deviceauth_authorization_pending") {
        await this.sleepMs(interval * 1000)
        return { state: "pending", userCode, interval }
      }
      if (err === "expired_token" || err === "access_denied" || err === "deviceauth_expired" || err === "deviceauth_access_denied") {
        CODE.delete(flowId)
        return { state: "error", detail: err }
      }
      return { state: "error", detail: `token error: ${err || res.status}` }
    } catch (e) {
      return { state: "error", detail: (e as Error).message }
    }
  }

  /** Exchange the device-polled authorization_code (PKCE) for real tokens at /oauth/token. */
  private async exchangeAuthorizationCode(flowId: string, cfg: OAuthConfig, polled: Record<string, unknown>): Promise<DeviceCodeResult> {
    const code = typeof polled["authorization_code"] === "string" ? polled["authorization_code"] : undefined
    const codeVerifier = typeof polled["code_verifier"] === "string" ? polled["code_verifier"] : undefined
    const codeChallenge = typeof polled["code_challenge"] === "string" ? polled["code_challenge"] : undefined
    if (!code || !codeVerifier) {
      return { state: "error", detail: "malformed authorization_code response" }
    }
    const redirectUri = cfg.deviceCallback ?? `${cfg.issuer}/deviceauth/callback`
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: cfg.clientId,
      code_verifier: codeVerifier,
    })
    if (codeChallenge) params.set("code_challenge", codeChallenge)
    try {
      const res = await this.fetchImpl(cfg.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      })
      const body = (await res.json()) as Record<string, unknown>
      if (!res.ok) return { state: "error", detail: `token exchange failed: HTTP ${res.status}` }
      const tokens = normalizeTokenResponse(body)
      if (!tokens.access_token) return { state: "error", detail: "token exchange returned no access_token" }
      await this.writeTokens(tokens)
      CODE.delete(flowId)
      return { state: "success", accessToken: tokens.access_token, refreshToken: tokens.refresh_token }
    } catch (e) {
      return { state: "error", detail: (e as Error).message }
    }
  }

  cancel(flowId: string): void {
    const gate = CODE.get(flowId)
    if (gate) gate.cancel = true
  }

  /** Blocking helper: poll until success/error (used by CLI-style callers). */
  async runDeviceFlow(flowId: string, deviceCode: string, interval: number, maxSeconds = 300): Promise<DeviceCodeResult> {
    const deadline = Date.now() + maxSeconds * 1000
    let last: DeviceCodeResult = { state: "pending" }
    while (Date.now() < deadline) {
      const gate = CODE.get(flowId)
      if (!gate || gate.cancel) return { state: "error", detail: "cancelled" }
      last = await this.pollDeviceCode(flowId, deviceCode, interval, last.userCode ?? "")
      if (last.state !== "pending") return last
    }
    return { state: "error", detail: "timed out" }
  }

  /** Refresh a stored refresh_token; persists the new pair. */
  async refresh(): Promise<boolean> {
    const tokens = await this.storedTokens()
    const refreshToken = tokens?.refresh_token
    if (!refreshToken) return false
    const cfg = this.cfg()
    try {
      const res = await this.fetchImpl(cfg.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: cfg.clientId,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      })
      if (!res.ok) return false
      const body = (await res.json()) as Record<string, unknown>
      const fresh = normalizeTokenResponse(body)
      if (!fresh.access_token) return false
      await this.writeTokens({ ...tokens, ...fresh })
      return true
    } catch {
      return false
    }
  }

  /** Returns a usable access token, refreshing if expired/absent. */
  async accessToken(): Promise<string | undefined> {
    const tokens = await this.storedTokens()
    if (tokens?.access_token && (!tokens.expires_at || tokens.expires_at > Date.now() + 60_000)) {
      return tokens.access_token
    }
    if (tokens?.refresh_token) {
      const ok = await this.refresh()
      if (ok) {
        const fresh = await this.storedTokens()
        return fresh?.access_token
      }
    }
    return undefined
  }

  /** Persist tokens to ~/.codex/auth.json in the AuthDotJson schema. */
  private async writeTokens(tokens: AuthTokens): Promise<void> {
    const existing = (await this.creds.load()) ?? {}
    await this.creds.save({
      ...existing,
      tokens,
      last_refresh: new Date().toISOString(),
    })
  }

  /** Revoke + delete stored credentials. */
  async logout(revoke = true): Promise<void> {
    const tokens = await this.storedTokens()
    if (revoke && tokens?.refresh_token) {
      const cfg = this.cfg()
      try {
        await this.fetchImpl(cfg.tokenEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_id: cfg.clientId,
            token_type_hint: "refresh_token",
            token: tokens.refresh_token,
          }),
        })
      } catch {
        /* best effort */
      }
    }
    await this.creds.delete()
  }
}
