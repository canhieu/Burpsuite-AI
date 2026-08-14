import { describe, it, expect, afterEach } from "vitest"
import { startTestServer, connectClient, sendRequest, type TestServer } from "./helper.js"

const servers: TestServer[] = []

async function boot() {
  const s = await startTestServer()
  servers.push(s)
  return s
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

async function authedClient(s: TestServer) {
  const c = await connectClient(s.url)
  c.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "handshake.hello", params: { projectId: "test-proj", nonce: "n1", token: s.config.authToken } }))
  const hello = await c.next()
  expect(hello).toMatchObject({ method: "agent.hello" })
  return c
}

describe("json-rpc framing", () => {
  it("responds with matching id and result for valid request", async () => {
    const s = await boot()
    const c = await authedClient(s)
    sendRequest(c.ws, 42, "agent.ping")
    const res = (await c.next()) as Record<string, unknown>
    expect(res["id"]).toBe(42)
    expect(res["result"]).toMatchObject({ pong: true })
    await c.close()
  })

  it("returns parse error on invalid JSON", async () => {
    const s = await boot()
    const c = await authedClient(s)
    c.ws.send("{not json")
    const res = (await c.next()) as Record<string, unknown>
    expect(res["error"]).toMatchObject({ code: -32700 })
    await c.close()
  })

  it("returns invalid request for missing method", async () => {
    const s = await boot()
    const c = await authedClient(s)
    c.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1 }))
    const res = (await c.next()) as Record<string, unknown>
    expect(res["error"]).toMatchObject({ code: -32600 })
    await c.close()
  })

  it("returns method not found for unknown method", async () => {
    const s = await boot()
    const c = await authedClient(s)
    sendRequest(c.ws, 7, "no.such.method")
    const res = (await c.next()) as Record<string, unknown>
    expect(res["error"]).toMatchObject({ code: -32601 })
    await c.close()
  })
})

describe("auth handshake", () => {
  it("accepts valid token and replies agent.hello", async () => {
    const s = await boot()
    const c = await connectClient(s.url)
    c.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "handshake.hello", params: { projectId: "p", nonce: "n", token: s.config.authToken } }))
    const hello = (await c.next()) as Record<string, unknown>
    expect(hello["method"]).toBe("agent.hello")
    expect(hello["params"]).toMatchObject({ ok: true })
    sendRequest(c.ws, 1, "agent.ping")
    const res = (await c.next()) as Record<string, unknown>
    expect(res["result"]).toMatchObject({ pong: true })
    await c.close()
  })

  it("rejects bad token with 401 and closes", async () => {
    const s = await boot()
    const c = await connectClient(s.url)
    const closed = new Promise<void>((resolve) => c.ws.on("close", () => resolve()))
    c.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "handshake.hello", params: { projectId: "p", nonce: "n", token: "wrong-token" } }))
    const res = (await c.next()) as Record<string, unknown>
    expect(res["error"]).toMatchObject({ code: 401 })
    await closed
  })

  it("closes unauthenticated requests", async () => {
    const s = await boot()
    const c = await connectClient(s.url)
    const closed = new Promise<void>((resolve) => c.ws.on("close", () => resolve()))
    sendRequest(c.ws, 1, "agent.ping")
    const res = (await c.next()) as Record<string, unknown>
    expect(res["error"]).toMatchObject({ code: 401 })
    await closed
  })
})

describe("streaming", () => {
  it("emits agent.event notifications then final result", async () => {
    const s = await boot()
    s.handlers.set("stream.demo", async (_params, ctx) => {
      ctx.sendAgentEvent("text", "hello ")
      ctx.sendAgentEvent("text", "world")
      ctx.sendAgentEvent("done", {})
      return { done: true }
    })
    const c = await authedClient(s)
    sendRequest(c.ws, "s1", "stream.demo")
    const e1 = (await c.next()) as Record<string, unknown>
    expect(e1["method"]).toBe("agent.event")
    expect(e1["params"]).toMatchObject({ type: "text", data: "hello " })
    const e2 = (await c.next()) as Record<string, unknown>
    expect(e2["params"]).toMatchObject({ type: "text", data: "world" })
    const e3 = (await c.next()) as Record<string, unknown>
    expect(e3["params"]).toMatchObject({ type: "done" })
    const res = (await c.next()) as Record<string, unknown>
    expect(res["id"]).toBe("s1")
    expect(res["result"]).toMatchObject({ done: true })
    await c.close()
  })
})

describe("idempotencyKey dedup", () => {
  it("returns cached result for repeated key", async () => {
    const s = await boot()
    let calls = 0
    s.handlers.set("mutate.demo", async (params) => ({ count: ++calls, key: params["idempotencyKey"] }))
    const c = await authedClient(s)
    sendRequest(c.ws, 1, "mutate.demo", { idempotencyKey: "k1" })
    sendRequest(c.ws, 2, "mutate.demo", { idempotencyKey: "k1" })
    const r1 = (await c.next()) as Record<string, unknown>
    const r2 = (await c.next()) as Record<string, unknown>
    expect(r1["result"]).toEqual(r2["result"])
    expect(r1["result"]).toMatchObject({ count: 1 })
    expect(calls).toBe(1)
    sendRequest(c.ws, 3, "mutate.demo", { idempotencyKey: "k2" })
    const r3 = (await c.next()) as Record<string, unknown>
    expect(r3["result"]).toMatchObject({ count: 2 })
    await c.close()
  })
})

describe("sidecar-local methods", () => {
  it("serves settings.get/set and payload.encode", async () => {
    const s = await boot()
    const c = await authedClient(s)
    sendRequest(c.ws, 1, "settings.set", { patch: { scope: ["*.example.com"] } })
    const r1 = (await c.next()) as Record<string, unknown>
    expect(r1["result"]).toMatchObject({ settings: { scope: ["*.example.com"] } })
    sendRequest(c.ws, 2, "settings.get", { paths: ["scope"] })
    const r2 = (await c.next()) as Record<string, unknown>
    expect(r2["result"]).toMatchObject({ settings: { scope: ["*.example.com"] } })
    sendRequest(c.ws, 3, "payload.encode", { algorithm: "base64", input: "hello" })
    const r3 = (await c.next()) as Record<string, unknown>
    expect(r3["result"]).toMatchObject({ output: "aGVsbG8=" })
    await c.close()
  })
})
