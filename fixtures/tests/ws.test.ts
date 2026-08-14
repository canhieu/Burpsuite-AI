import { describe, it, expect, beforeAll, afterAll } from "vitest"
import WebSocket from "ws"
import { startWsServer, type WsServerHandle } from "../src/ws_server.js"

interface WsClient {
  socket: WebSocket
  messages: unknown[]
  next: (timeoutMs?: number) => Promise<unknown>
}

function connect(url: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const messages: unknown[] = []
    const waiters: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = []
    socket.on("message", (data) => {
      const msg: unknown = JSON.parse(data.toString())
      const waiter = waiters.shift()
      if (waiter) waiter.resolve(msg)
      else messages.push(msg)
    })
    socket.on("error", (err) => {
      const waiter = waiters.shift()
      if (waiter) waiter.reject(err)
    })
    socket.on("open", () => {
      const next = async (timeoutMs = 5000) => {
        if (messages.length > 0) return messages.shift()
        return new Promise<unknown>((res, rej) => {
          const timer = setTimeout(() => rej(new Error("ws message timeout")), timeoutMs)
          waiters.push({
            resolve: (v) => {
              clearTimeout(timer)
              res(v)
            },
            reject: (e) => {
              clearTimeout(timer)
              rej(e)
            },
          })
        })
      }
      resolve({ socket, messages, next })
    })
  })
}

function close(client: WsClient): Promise<void> {
  return new Promise((resolve) => {
    client.socket.on("close", () => resolve())
    client.socket.close()
  })
}

describe("ws echo/chat mock", () => {
  let handle: WsServerHandle
  let url: string

  beforeAll(async () => {
    handle = await startWsServer()
    url = handle.url
  })

  afterAll(async () => {
    await handle.close()
  })

  it("subscribe handshake replies subscribed", async () => {
    const client = await connect(url)
    client.socket.send(JSON.stringify({ action: "subscribe", channel: "orders" }))
    const msg = await client.next()
    expect(msg).toEqual({ status: "subscribed", channel: "orders" })
    await close(client)
  })

  it("ping/pong works", async () => {
    const client = await connect(url)
    client.socket.send(JSON.stringify({ action: "ping", payload: { probe: 1 } }))
    const msg = (await client.next()) as { pong: boolean; echo: unknown }
    expect(msg.pong).toBe(true)
    expect(msg.echo).toEqual({ probe: 1 })
    await close(client)
  })

  it("receives order message once after subscribe", async () => {
    const client = await connect(url)
    client.socket.send(JSON.stringify({ action: "subscribe", channel: "orders" }))
    await client.next()
    const order = await client.next()
    expect(order).toEqual({ order_id: 102, owner_id: 7 })
    const next = await client.next()
    expect(next).not.toEqual({ order_id: 102, owner_id: 7 })
    await close(client)
  })

  it("receives periodic broadcast to subscribers", async () => {
    const client = await connect(url)
    client.socket.send(JSON.stringify({ action: "subscribe", channel: "orders" }))
    await client.next()
    await client.next()
    const tick = (await client.next()) as { type: string; channel: string }
    expect(tick.type).toBe("tick")
    expect(tick.channel).toBe("orders")
    await close(client)
  })

  it("rejects unknown channels", async () => {
    const client = await connect(url)
    client.socket.send(JSON.stringify({ action: "subscribe", channel: "stocks" }))
    const msg = (await client.next()) as { status: string }
    expect(msg.status).toBe("error")
    await close(client)
  })
})
