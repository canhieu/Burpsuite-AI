import { createServer, type Server } from "node:http"
import { WebSocketServer, WebSocket } from "ws"

export interface WsServerOptions {
  port?: number
  host?: string
}

export interface WsServerHandle {
  server: Server
  wss: WebSocketServer
  port: number
  url: string
  close: () => Promise<void>
}

const DEFAULT_HOST = process.env.HOST ?? "127.0.0.1"
const ORDER_MESSAGE = { order_id: 102, owner_id: 7 }
const BROADCAST_INTERVAL_MS = 2000

interface ClientState {
  subscribed: boolean
  orderSent: boolean
}

export async function startWsServer(opts: WsServerOptions = {}): Promise<WsServerHandle> {
  const port = opts.port ?? 0
  const host = opts.host ?? DEFAULT_HOST
  const server = createServer((_req, res) => {
    res.writeHead(426, { "content-type": "application/json", upgrade: "websocket" })
    res.end(JSON.stringify({ error: "websocket endpoint, use a ws:// client" }))
  })
  const wss = new WebSocketServer({ server, path: "/" })
  const subscribers = new Set<WebSocket>()

  wss.on("connection", (socket) => {
    const state: ClientState = { subscribed: false, orderSent: false }
    socket.on("message", (data) => {
      let msg: unknown
      try {
        msg = JSON.parse(data.toString())
      } catch {
        socket.send(JSON.stringify({ error: "invalid json" }))
        return
      }
      if (typeof msg !== "object" || msg === null) {
        socket.send(JSON.stringify({ error: "invalid message" }))
        return
      }
      const action = (msg as Record<string, unknown>).action
      if (action === "subscribe") {
        const channel = (msg as Record<string, unknown>).channel ?? ""
        if (channel !== "orders") {
          socket.send(JSON.stringify({ status: "error", reason: `unknown channel ${channel}` }))
          return
        }
        state.subscribed = true
        subscribers.add(socket)
        socket.send(JSON.stringify({ status: "subscribed", channel }))
        if (!state.orderSent) {
          state.orderSent = true
          socket.send(JSON.stringify(ORDER_MESSAGE))
        }
        return
      }
      if (action === "ping") {
        const payload = (msg as Record<string, unknown>).payload ?? null
        socket.send(JSON.stringify({ pong: true, ts: Date.now(), echo: payload }))
        return
      }
      if (action === "unsubscribe") {
        state.subscribed = false
        subscribers.delete(socket)
        socket.send(JSON.stringify({ status: "unsubscribed" }))
        return
      }
      socket.send(JSON.stringify({ error: "unknown action" }))
    })
    socket.on("close", () => {
      subscribers.delete(socket)
    })
  })

  const broadcastTimer = setInterval(() => {
    const tick = { type: "tick", channel: "orders", ts: Date.now(), data: { price: Math.random() * 100 } }
    const payload = JSON.stringify(tick)
    for (const socket of subscribers) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload)
    }
  }, BROADCAST_INTERVAL_MS)
  broadcastTimer.unref()

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, resolve)
  })

  const address = server.address()
  const actualPort = typeof address === "object" && address !== null ? address.port : port

  return {
    server,
    wss,
    port: actualPort,
    url: `ws://${host}:${actualPort}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of wss.clients) socket.close()
        wss.close(() => {
          if (!server.listening) {
            resolve()
            return
          }
          server.close(() => resolve())
        })
      }),
  }
}
