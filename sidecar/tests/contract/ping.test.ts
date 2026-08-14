import { describe, it, expect } from "vitest"
import { startTestServer, connectClient, sendRequest, type TestServer } from "../helper.js"

describe("contract: real server handshake + agent.ping", () => {
  it("handshakes and pings over WebSocket on ephemeral port", async () => {
    const s: TestServer = await startTestServer()
    const c = await connectClient(s.url)

    c.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "handshake.hello",
        params: { projectId: "contract-proj", nonce: "nonce-1", token: s.config.authToken },
      }),
    )
    const hello = (await c.next()) as Record<string, unknown>
    expect(hello["method"]).toBe("agent.hello")
    expect(hello["params"]).toMatchObject({ ok: true, sidecarVersion: "0.1.0" })

    sendRequest(c.ws, 1, "agent.ping")
    const res = (await c.next()) as Record<string, unknown>
    expect(res["id"]).toBe(1)
    expect(res["result"]).toMatchObject({ pong: true, version: "0.1.0" })
    expect(typeof (res["result"] as Record<string, unknown>)["uptimeMs"]).toBe("number")

    await c.close()
    await s.close()
  })

  it("rejects the wrong token end-to-end", async () => {
    const s: TestServer = await startTestServer()
    const c = await connectClient(s.url)
    const closed = new Promise<void>((resolve) => c.ws.on("close", () => resolve()))
    c.ws.send(
      JSON.stringify({ jsonrpc: "2.0", method: "handshake.hello", params: { projectId: "p", nonce: "n", token: "bad" } }),
    )
    const res = (await c.next()) as Record<string, unknown>
    expect(res["error"]).toMatchObject({ code: 401 })
    await closed
    await s.close()
  })
})
