import { randomBytes, createHash } from "node:crypto"
import { createServer } from "node:http"
import { createCredentialFile, claudeCredentialsPath, normalizeTokenResponse, type AuthTokens, type OAuthConfig } from "./credentials.js"

/**
 * Claude Code-compatible OAuth (auth-code + PKCE, loopback browser flow).
 * Stores tokens in the SAME ~/.claude/.credentials.json Claude Code uses
 * (shape: { oauthAccount: { oauthAccountId, claudeAccessToken,
 * claudeRefreshToken, expiresAt } }), so both tools share one session.
 */
export interface ClaudeOAuthOptions {
  config: OAuthConfig
  credentialsPath?: string
  fetchImpl?: typeof fetch
  openBrowser?: (url: string) => Promise<void> | void
}

export interface ClaudeLoginResult {
  state: "pending" | "success" | "error"
  authUrl?: string
  detail?: string
}

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_")
}

export class ClaudeOAuth {
  private creds: ReturnType<typeof createCredentialFile>
  private fetchImpl: typeof fetch

  constructor(private opts: ClaudeOAuthOptions) {
    this.creds = createCredentialFile(this.opts.credentialsPath ?? claudeCredentialsPath())
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
  }

  private cfg(): OAuthConfig {
    return this.opts.config
  }

  async hasSession(): Promise<boolean> {
    const creds = await this.creds.load()
    return !!(creds && creds["oauthAccount"])
  }

  async storedTokens(): Promise<AuthTokens | undefined> {
    const creds = await this.creds.load()
    const oa = creds?.["oauthAccount"]
    if (!oa || typeof oa !== "object") return undefined
    const o = oa as Record<string, unknown>
    return {
      access_token: typeof o["claudeAccessToken"] === "string" ? o["claudeAccessToken"] : undefined,
      refresh_token: typeof o["claudeRefreshToken"] === "string" ? o["claudeRefreshToken"] : undefined,
      account_id: typeof o["oauthAccountId"] === "string" ? o["oauthAccountId"] : undefined,
      expires_at: typeof o["expiresAt"] === "number" ? o["expiresAt"] : undefined,
    }
  }

  /**
   * Start the loopback browser flow:
   *  - generate PKCE verifier + challenge
   *  - bind a one-shot local HTTP server on the configured redirect port
   *  - return authUrl to open in the browser
   * Caller polls complete() for the result.
   */
  async startBrowserFlow(): Promise<{ loginId: string; authUrl?: string; detail?: string }> {
    const cfg = this.cfg()
    if (!cfg.authorizeEndpoint) return { loginId: "", detail: "authorize endpoint not configured" }
    const verifier = base64url(randomBytes(48))
    const challenge = base64url(createHash("sha256").update(verifier).digest())
    const state = base64url(randomBytes(24))
    const redirectUri = cfg.redirectUri || "http://127.0.0.1:14574/oauth/callback"
    const url = new URL(cfg.authorizeEndpoint)
    url.searchParams.set("response_type", "code")
    url.searchParams.set("client_id", cfg.clientId)
    url.searchParams.set("redirect_uri", redirectUri)
    url.searchParams.set("code_challenge", challenge)
    url.searchParams.set("code_challenge_method", "S256")
    url.searchParams.set("state", state)
    const loginId = state
    const server = createServer(async (req, res) => {
      const u = new URL(req.url || "/", redirectUri)
      if (u.searchParams.get("state") !== state) {
        res.writeHead(400)
        res.end("state mismatch")
        return
      }
      const code = u.searchParams.get("code")
      if (code) {
        try {
          const tokens = await this.exchangeCode(code, verifier, redirectUri)
          if (tokens.access_token) {
            await this.writeTokens(tokens)
            const flow = pending.get(state)
            if (flow) flow.success = true
            res.writeHead(200, { "content-type": "text/html" })
            res.end("<!doctype html><title>Done</title><p>Logged in. You can close this tab.</p>")
            server.close()
            return
          }
        } catch (e) {
          res.writeHead(500)
          res.end("token exchange failed")
          return
        }
      }
      res.writeHead(400)
      res.end("missing code")
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => resolve())
    })
    const port = (server.address() as { port: number }).port
    // Persist flow state so complete() can read the result.
    pending.set(loginId, { server, verifier, redirectUri, port, success: false })
    const authUrl = url.toString()
    return { loginId, authUrl }
  }

  /** Wait for the flow to complete (or timeout). */
  async complete(loginId: string, timeoutMs = 300_000): Promise<ClaudeLoginResult> {
    const flow = pending.get(loginId)
    if (!flow) return { state: "error", detail: "unknown login" }
    const result = await new Promise<ClaudeLoginResult>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(loginId)
        resolve({ state: "error", detail: "timed out waiting for browser" })
      }, timeoutMs)
      flow.server.on("close", () => {
        clearTimeout(timer)
        pending.delete(loginId)
        const ok = flow.success
        resolve(ok ? { state: "success" } : { state: "error", detail: "login cancelled or failed" })
      })
    })
    return result
  }

  /** Refresh a stored refresh_token. Persists new tokens. */
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

  private async exchangeCode(code: string, verifier: string, redirectUri: string): Promise<AuthTokens> {
    const cfg = this.cfg()
    const res = await this.fetchImpl(cfg.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: cfg.clientId,
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    })
    if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`)
    const body = (await res.json()) as Record<string, unknown>
    return normalizeTokenResponse(body)
  }

  private async writeTokens(tokens: AuthTokens): Promise<void> {
    const existing = (await this.creds.load()) ?? {}
    await this.creds.save({
      ...existing,
      oauthAccount: {
        oauthAccountId: tokens.account_id ?? "",
        claudeAccessToken: tokens.access_token,
        claudeRefreshToken: tokens.refresh_token,
        expiresAt: tokens.expires_at ?? 0,
      },
    })
  }
}

interface PendingFlow {
  server: ReturnType<typeof createServer>
  verifier: string
  redirectUri: string
  port: number
  success: boolean
}

const pending = new Map<string, PendingFlow>()