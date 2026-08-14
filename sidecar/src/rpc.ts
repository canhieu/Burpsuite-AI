import { WebSocketServer, WebSocket } from "ws"
import type { IncomingMessage } from "node:http"
import type { SidecarConfig } from "./config.js"
import type { Logger } from "./util.js"
import type { RpcRequest, RpcNotification, RpcResponse, RpcId } from "./types.js"
import { RpcError, type Handler, type RpcContext, type Services } from "./handlers/types.js"

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const AUTH_FAILED = 401
const INTERNAL = 500

interface Session {
  authed: boolean
  projectId?: string
  ws: WebSocket
}

interface Inflight {
  promise: Promise<unknown>
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TimeoutError"
  }
}

export class RpcServer {
  private wss: WebSocketServer
  private sessions = new Map<WebSocket, Session>()
  private idempotent = new Map<string, Inflight>()
  private clientSocket: WebSocket | null = null
  private pending = new Map<RpcId, PendingRequest>()
  private nextRequestId = 0

  constructor(
    private config: SidecarConfig,
    private services: Services,
    private log: Logger,
    private handlers: Map<string, Handler>,
    private sidecarVersion: string,
  ) {
    this.wss = new WebSocketServer({ noServer: true })
    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      this.onConnection(ws, req)
    })
  }

  attach(server: import("node:http").Server): void {
    server.on("upgrade", (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req)
      })
    })
  }

  onConnection(ws: WebSocket, req: IncomingMessage): void {
    const addr = req.socket.remoteAddress ?? "loopback"
    if (this.config.localOnly && addr !== "127.0.0.1" && addr !== "::1" && addr !== "::ffff:127.0.0.1") {
      this.log.warn(`rejecting non-loopback connection from ${addr}`)
      ws.close(4003, "localOnly")
      return
    }
    this.sessions.set(ws, { authed: false, ws })
    this.clientSocket = ws
    this.log.info(`client connected: ${addr}`)
    ws.on("message", (data) => {
      const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      void this.onMessage(ws, raw)
    })
    ws.on("close", () => {
      this.sessions.delete(ws)
      if (this.clientSocket === ws) this.clientSocket = null
      this.rejectPending(new Error("client disconnected"))
      this.log.info("client disconnected")
    })
    ws.on("error", (err) => {
      this.log.debug(`ws error: ${err.message}`)
    })
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  setClientSocket(ws: WebSocket | null): void {
    this.clientSocket = ws
  }

  emit(method: string, params?: Record<string, unknown>): void {
    const ws = this.clientSocket
    if (ws && ws.readyState === WebSocket.OPEN) {
      this.send(ws, { jsonrpc: "2.0", method, params })
    }
  }

  getClientContext(): RpcContext {
    const ws = this.clientSocket
    if (!ws) throw new RpcError(-32000, "no client connected")
    const session = this.sessions.get(ws)
    return {
      ws,
      authed: !!session?.authed,
      projectId: session?.projectId,
      sendNotification: (method, params) => this.emit(method, params),
      sendAgentEvent: (type, data) => this.emit("agent.event", { type, data }),
    }
  }

  request(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown> {
    const ws = this.clientSocket
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new RpcError(-32000, "extension not connected"))
    }
    const id = this.nextRequestId++
    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = opts?.timeoutMs ?? 60_000
      const timer = setTimeout(() => {
        this.cancelPending(id, new TimeoutError(`request ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const signal = opts?.signal
      const onAbort = () => this.cancelPending(id, new RpcError(-32000, "request aborted"))
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer)
          reject(new RpcError(-32000, "request aborted"))
          return
        }
        signal.addEventListener("abort", onAbort, { once: true })
      }
      this.pending.set(id, { resolve, reject, timer, signal, onAbort })
      this.send(ws, { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })
    })
  }

  private cancelPending(id: RpcId, err: unknown): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.signal?.removeEventListener("abort", entry.onAbort!)
    entry.reject(err)
  }

  private rejectPending(err: unknown): void {
    for (const id of [...this.pending.keys()]) this.cancelPending(id, err)
  }

  private handleResponse(body: Record<string, unknown>): void {
    const raw = body["id"]
    const id = typeof raw === "number" || typeof raw === "string" ? (raw as RpcId) : undefined
    if (id === undefined) return
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.signal?.removeEventListener("abort", entry.onAbort!)
    if (body["error"] && typeof body["error"] === "object") {
      const e = body["error"] as { code?: unknown; message?: unknown }
      const code = typeof e.code === "number" ? e.code : -32000
      const message = typeof e.message === "string" ? e.message : "request failed"
      entry.reject(new RpcError(code, message))
    } else {
      entry.resolve(body["result"])
    }
  }

  private makeCtx(session: Session): RpcContext {
    return {
      ws: session.ws,
      authed: session.authed,
      projectId: session.projectId,
      sendNotification: (method, params) => {
        this.send(session.ws, { jsonrpc: "2.0", method, params } satisfies RpcNotification)
      },
      sendAgentEvent: (type, data) => {
        this.send(session.ws, { jsonrpc: "2.0", method: "agent.event", params: { type, data } })
      },
    }
  }

  private response(id: RpcId | null, result?: unknown, error?: { code: number; message: string; data?: unknown }): RpcResponse {
    const out: RpcResponse = { jsonrpc: "2.0", id }
    if (error) out.error = error
    else out.result = result
    return out
  }

  private async onMessage(ws: WebSocket, data: Buffer): Promise<void> {
    const session = this.sessions.get(ws)
    if (!session) return

    let msg: unknown
    try {
      msg = JSON.parse(data.toString("utf8"))
    } catch {
      this.send(ws, this.response(null, undefined, { code: PARSE_ERROR, message: "parse error" }))
      return
    }

    if (Array.isArray(msg)) {
      this.send(ws, this.response(null, undefined, { code: INVALID_REQUEST, message: "batch requests not supported" }))
      return
    }
    if (!msg || typeof msg !== "object") {
      this.send(ws, this.response(null, undefined, { code: INVALID_REQUEST, message: "invalid request" }))
      return
    }

    const body = msg as Record<string, unknown>
    if (!("method" in body) && "id" in body && ("result" in body || "error" in body)) {
      this.handleResponse(body)
      return
    }
    if (body["jsonrpc"] !== "2.0" || typeof body["method"] !== "string") {
      const id = typeof body["id"] === "number" || typeof body["id"] === "string" ? (body["id"] as RpcId) : null
      this.send(ws, this.response(id, undefined, { code: INVALID_REQUEST, message: "invalid request" }))
      return
    }

    const method = body["method"] as string
    const hasId = "id" in body
    const id: RpcId | null = hasId ? (body["id"] as RpcId) : null
    const params = (body["params"] ?? {}) as Record<string, unknown>

    if (!session.authed) {
      if (method === "handshake.hello") {
        this.handleHandshake(session, params)
      } else {
        this.send(ws, this.response(id, undefined, { code: AUTH_FAILED, message: "handshake required" }))
        ws.close(4001, "handshake required")
      }
      return
    }

    if (method === "handshake.hello") {
      this.handleHandshake(session, params)
      return
    }

    if (!hasId) {
      await this.dispatch(session, method, params, id, true)
      return
    }
    await this.dispatch(session, method, params, id, false)
  }

  private handleHandshake(session: Session, params: Record<string, unknown>): void {
    const token = typeof params["token"] === "string" ? params["token"] : undefined
    const projectId = typeof params["projectId"] === "string" ? params["projectId"] : undefined
    const nonce = typeof params["nonce"] === "string" ? params["nonce"] : undefined
    if (!token || !projectId || !nonce || token !== this.config.authToken) {
      this.log.warn("handshake failed: token mismatch")
      this.send(session.ws, this.response(null, undefined, { code: AUTH_FAILED, message: "auth failed", data: { reason: "invalid token" } }))
      session.ws.close(4001, "auth failed")
      return
    }
    session.authed = true
    session.projectId = projectId
    this.log.info(`handshake ok: projectId=${projectId}`)
    this.send(session.ws, {
      jsonrpc: "2.0",
      method: "agent.hello",
      params: { ok: true, sidecarVersion: this.sidecarVersion },
    } satisfies RpcNotification)
  }

  private async dispatch(
    session: Session,
    method: string,
    params: Record<string, unknown>,
    id: RpcId | null,
    isNotification: boolean,
  ): Promise<void> {
    const handler = this.handlers.get(method)
    if (!handler) {
      if (!isNotification) this.send(session.ws, this.response(id, undefined, { code: METHOD_NOT_FOUND, message: `method not found: ${method}` }))
      return
    }

    const key = params["idempotencyKey"]
    const cacheKey = key ? `${method}:${String(key)}` : undefined
    const ctx = this.makeCtx(session)

    const run = async (): Promise<unknown> => handler(params, ctx, this.services)

    if (cacheKey) {
      const existing = this.idempotent.get(cacheKey)
      if (existing) {
        try {
          const cached = await existing.promise
          if (!isNotification) this.send(session.ws, this.response(id, cached, undefined))
        } catch (err) {
          this.sendError(session.ws, id, err)
        }
        return
      }
      const inflight: Inflight = { promise: (async () => run())() }
      this.idempotent.set(cacheKey, inflight)
      try {
        const result = await inflight.promise
        if (!isNotification) this.send(session.ws, this.response(id, result, undefined))
      } catch (err) {
        if (!isNotification) this.sendError(session.ws, id, err)
      } finally {
        this.idempotent.delete(cacheKey)
      }
      return
    }

    try {
      const result = await run()
      if (!isNotification) this.send(session.ws, this.response(id, result, undefined))
    } catch (err) {
      if (!isNotification) this.sendError(session.ws, id, err)
      else this.log.debug(`notification handler error: ${(err as Error).message}`)
    }
  }

  private sendError(ws: WebSocket, id: RpcId | null, err: unknown): void {
    if (err instanceof RpcError) {
      const error: { code: number; message: string; data?: unknown } = { code: err.code, message: err.message }
      if (err.data !== undefined) error.data = err.data
      this.send(ws, this.response(id, undefined, error))
      return
    }
    if (err instanceof Error) {
      this.send(ws, this.response(id, undefined, { code: INTERNAL, message: err.message }))
      return
    }
    this.send(ws, this.response(id, undefined, { code: INTERNAL, message: "internal error" }))
  }

  close(): void {
    for (const ws of this.wss.clients) ws.close(1001, "server shutdown")
    this.wss.close()
    this.connectingWs?.close(1001, "server shutdown")
  }

  /**
   * Connect OUT to an extension's WS server (the extension is the WS server;
   * the sidecar is spawned by the extension and dials back to it).
   * Env: BURP_AGENT_WS_URL, BURP_AGENT_TOKEN, BURP_AGENT_NONCE, BURP_AGENT_PROJECT_ID.
   * Reconnects with backoff until stopped.
   */
  connectToExtension(opts?: { maxAttempts?: number; backoffMs?: number }): void {
    const url = process.env["BURP_AGENT_WS_URL"]
    const token = process.env["BURP_AGENT_TOKEN"]
    const nonce = process.env["BURP_AGENT_NONCE"]
    const projectId = process.env["BURP_AGENT_PROJECT_ID"]
    if (!url || !token) {
      this.log.info("BURP_AGENT_WS_URL not set; running standalone (no extension)")
      return
    }
    const maxAttempts = opts?.maxAttempts ?? 3
    const backoffMs = opts?.backoffMs ?? 1500
    this.log.info(`connecting out to extension ws ${url}`)
    this.connectLoop(url, { token, nonce, projectId }, maxAttempts, backoffMs)
  }

  private connectingWs: WebSocket | null = null
  private connectStop = false

  private connectLoop(
    url: string,
    handshake: { token: string; nonce?: string; projectId?: string },
    maxAttempts: number,
    backoffMs: number,
  ): void {
    if (this.connectStop) return
    const ws = new WebSocket(url)
    this.connectingWs = ws
    const self = this
    ws.on("open", () => {
      this.log.info("connected to extension; sending handshake")
      this.registerOutbound(ws)
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "handshake.hello",
          params: {
            projectId: handshake.projectId ?? "unknown",
            nonce: handshake.nonce ?? "n",
            token: handshake.token,
          },
        } satisfies RpcNotification),
      )
    })
    const scheduleRetry = (attempt: number, reason: string) => {
      this.log.warn(`extension connection failed (${reason}); attempt ${attempt}/${maxAttempts}`)
      if (attempt >= maxAttempts || this.connectStop) return
      setTimeout(() => {
        if (!this.connectStop) this.connectLoop(url, handshake, maxAttempts, backoffMs)
      }, backoffMs * attempt)
    }
    ws.on("close", () => {
      this.log.info("extension ws closed")
      if (this.clientSocket === ws) this.clientSocket = null
      this.rejectPending(new Error("extension disconnected"))
      scheduleRetry(1, "closed")
    })
    ws.on("error", (err) => {
      this.log.debug(`extension ws error: ${err.message}`)
      scheduleRetry(1, err.message)
    })
  }

  /** Treat an outbound extension socket like an inbound client: parse+dispatch, and act as our request target. */
  private registerOutbound(ws: WebSocket): void {
    const session: Session = { authed: false, ws }
    this.sessions.set(ws, session)
    this.clientSocket = ws
    // The extension will reply with agent.hello; then it is authed. Mark authed once handshake sent.
    // We send handshake from the client side, so assume authed after a short grace; the extension
    // enforces its own token check and closes us on mismatch.
    session.authed = true
    ws.on("message", (data) => {
      const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      void this.onMessage(ws, raw)
    })
  }

  stop(): void {
    this.connectStop = true
    this.connectingWs?.close(1001, "stopped")
  }
}

export function parseHandshake(msg: RpcRequest): { projectId: string; nonce: string; token: string } | undefined {
  const p = msg.params
  if (!p) return undefined
  const { projectId, nonce, token } = p as unknown as { projectId: unknown; nonce: unknown; token: unknown }
  if (typeof projectId !== "string" || typeof nonce !== "string" || typeof token !== "string") return undefined
  return { projectId, nonce, token }
}
