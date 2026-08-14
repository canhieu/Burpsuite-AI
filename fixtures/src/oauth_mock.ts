import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http"
import { randomBytes, createHash } from "node:crypto"

export interface OauthServerOptions {
  port?: number
  host?: string
}

export interface OauthServerHandle {
  server: Server
  port: number
  url: string
  close: () => Promise<void>
}

const DEFAULT_HOST = process.env.HOST ?? "127.0.0.1"
const USER_CODE = "ABCD-1234"

interface DeviceState {
  clientId: string
  approved: boolean
  createdAt: number
  verifier: string
  challenge: string
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function newCode(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`
}

export async function startOauthServer(opts: OauthServerOptions = {}): Promise<OauthServerHandle> {
  const port = opts.port ?? 0
  const host = opts.host ?? DEFAULT_HOST
  const devices = new Map<string, DeviceState>()
  const authCodes = new Map<string, { clientId: string; verifier: string; challenge: string; used: boolean }>()

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)

      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" })
        return
      }

      const bodyRaw = await readBody(req)
      let body: Record<string, unknown> = {}
      try {
        if ((req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded")) {
          body = Object.fromEntries(new URLSearchParams(bodyRaw))
        } else {
          body = bodyRaw.length > 0 ? JSON.parse(bodyRaw) : {}
        }
      } catch {
        sendJson(res, 400, { error: "invalid json" })
        return
      }

      // Legacy RFC-8628 device code endpoint (kept for old configs/tests).
      if (url.pathname === "/oauth/device/code") {
        const deviceCode = randomBytes(16).toString("hex")
        const clientId = String(body.client_id ?? "fixture-client")
        const verifier = randomBytes(24).toString("base64url")
        const challenge = createHash("sha256").update(verifier).digest("base64url")
        devices.set(deviceCode, { clientId, approved: false, createdAt: Date.now(), verifier, challenge })
        sendJson(res, 200, {
          device_code: deviceCode,
          user_code: USER_CODE,
          verification_uri: `${host === "0.0.0.0" ? "http://127.0.0.1" : `http://${host}`}:${port}/oauth/device`,
          verification_uri_complete: `${host === "0.0.0.0" ? "http://127.0.0.1" : `http://${host}`}:${port}/oauth/device?user_code=${USER_CODE}`,
          interval: 1,
          expires_in: 600,
        })
        return
      }

      // New ChatGPT /api/accounts/deviceauth/usercode
      if (url.pathname === "/api/accounts/deviceauth/usercode") {
        const deviceAuthId = `deviceauth_${randomBytes(16).toString("hex")}`
        const clientId = String(body.client_id ?? "fixture-client")
        const verifier = randomBytes(24).toString("base64url")
        const challenge = createHash("sha256").update(verifier).digest("base64url")
        devices.set(deviceAuthId, { clientId, approved: false, createdAt: Date.now(), verifier, challenge })
        sendJson(res, 200, {
          device_auth_id: deviceAuthId,
          user_code: USER_CODE,
          interval: "1",
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        })
        return
      }

      // New ChatGPT /api/accounts/deviceauth/token (poll)
      if (url.pathname === "/api/accounts/deviceauth/token") {
        const deviceAuthId = String(body.device_auth_id ?? "")
        const userCode = String(body.user_code ?? "")
        const state = devices.get(deviceAuthId)
        if (!state) {
          sendJson(res, 403, { error: { code: "deviceauth_authorization_pending", message: "Device authorization is pending." } })
          return
        }
        if (!state.approved) {
          sendJson(res, 403, { error: { code: "deviceauth_authorization_pending", message: "Device authorization is pending." } })
          return
        }
        const code = newCode("authcode")
        authCodes.set(code, { clientId: state.clientId, verifier: state.verifier, challenge: state.challenge, used: false })
        sendJson(res, 200, {
          authorization_code: code,
          code_challenge: state.challenge,
          code_verifier: state.verifier,
        })
        return
      }

      if (url.pathname === "/oauth/approve") {
        const id = String(body.device_code ?? body.device_auth_id ?? "")
        const state = devices.get(id)
        if (!state) {
          sendJson(res, 404, { error: "unknown device_code" })
          return
        }
        state.approved = true
        sendJson(res, 200, { approved: true })
        return
      }

      if (url.pathname === "/oauth/token") {
        const grant = String(body.grant_type ?? "")
        // New: exchange authorization_code via PKCE
        if (grant === "authorization_code") {
          const code = String(body.code ?? "")
          const entry = authCodes.get(code)
          if (!entry || entry.used) {
            sendJson(res, 400, { error: "invalid_grant", error_description: "invalid authorization_code" })
            return
          }
          const verifier = String(body.code_verifier ?? "")
          const challenge = createHash("sha256").update(verifier).digest("base64url")
          if (challenge !== entry.challenge) {
            sendJson(res, 400, { error: "invalid_grant", error_description: "code_verifier mismatch" })
            return
          }
          entry.used = true
          sendJson(res, 200, {
            access_token: newCode("at"),
            refresh_token: newCode("rt"),
            id_token: newCode("id"),
            expires_in: 3600,
            token_type: "bearer",
          })
          return
        }
        // Legacy device_code grant
        if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
          const deviceCode = String(body.device_code ?? "")
          const state = devices.get(deviceCode)
          if (!state) {
            sendJson(res, 400, { error: "invalid_grant", error_description: "unknown device_code" })
            return
          }
          if (!state.approved) {
            sendJson(res, 400, { error: "authorization_pending", error_description: "user has not approved yet" })
            return
          }
          sendJson(res, 200, {
            access_token: newCode("at"),
            refresh_token: newCode("rt"),
            expires_in: 3600,
            token_type: "bearer",
            scope: String(body.scope ?? ""),
          })
          return
        }
        if (grant === "refresh_token") {
          const refresh = String(body.refresh_token ?? "")
          if (!refresh.startsWith("rt_")) {
            sendJson(res, 400, { error: "invalid_grant", error_description: "invalid refresh_token" })
            return
          }
          sendJson(res, 200, {
            access_token: newCode("at"),
            refresh_token: newCode("rt"),
            expires_in: 3600,
            token_type: "bearer",
          })
          return
        }
        sendJson(res, 400, { error: "unsupported_grant_type" })
        return
      }

      sendJson(res, 404, { error: "unknown endpoint" })
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "internal error", detail: String(err) }))
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, resolve)
  })

  const address = server.address()
  const actualPort = typeof address === "object" && address !== null ? address.port : port

  return {
    server,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close: () =>
      new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve()
          return
        }
        server.close(() => resolve())
      }),
  }
}
