import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { startHttpServer, type HttpServerHandle } from "../src/http_server.js"

describe("http target-app mock", () => {
  let handle: HttpServerHandle
  let base: string

  beforeAll(async () => {
    handle = await startHttpServer({ scenario: "normal" })
    base = handle.url
  })

  afterAll(async () => {
    await handle.close()
  })

  it("GET / returns html index", async () => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("<html>")
  })

  it("GET /health returns {ok:true}", async () => {
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("POST /api/orders/:id echoes id and requires auth", async () => {
    const res = await fetch(`${base}/api/orders/42`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok" },
      body: JSON.stringify({ qty: 2 }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { id: string; echo: unknown }
    expect(json.id).toBe("42")
    expect(json.echo).toEqual({ qty: 2 })
  })

  it("POST /api/orders/:id returns 401 without Authorization", async () => {
    const res = await fetch(`${base}/api/orders/42`, { method: "POST" })
    expect(res.status).toBe(401)
  })

  it("IDOR differential: id 50 vs 150 have different owners", async () => {
    const a = await fetch(`${base}/api/users/50`)
    const b = await fetch(`${base}/api/users/150`)
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const jsonA = (await a.json()) as { owner: string }
    const jsonB = (await b.json()) as { owner: string }
    expect(jsonA.owner).toBe("accountA")
    expect(jsonB.owner).toBe("accountB")
    expect(jsonA.owner).not.toBe(jsonB.owner)
  })

  it("GET /api/users/:id supports delay option", async () => {
    const start = Date.now()
    const res = await fetch(`${base}/api/users/7?delay=50`)
    const json = (await res.json()) as { owner: string }
    expect(json.owner).toBe("accountA")
    expect(Date.now() - start).toBeGreaterThanOrEqual(45)
  })

  it("SQLi: q with quote returns 500 with SQL error text", async () => {
    const bad = await fetch(`${base}/api/search?q=${encodeURIComponent("' OR 1=1 --")}`, {
      method: "POST",
    })
    expect(bad.status).toBe(500)
    expect(await bad.text()).toContain("SQLite syntax error")
    const good = await fetch(`${base}/api/search?q=widgets`, { method: "POST" })
    expect(good.status).toBe(200)
    const json = (await good.json()) as { results: unknown[] }
    expect(json.results.length).toBe(2)
  })

  it("GET /api/redirect returns 302 to /health", async () => {
    const res = await fetch(`${base}/api/redirect`, { redirect: "manual" })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/health")
  })

  it("GET /api/reflect reflects x unescaped", async () => {
    const res = await fetch(`${base}/api/reflect?x=${encodeURIComponent("<script>alert(1)</script>")}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("<script>alert(1)</script>")
  })

  it("GET /api/echoheaders returns request headers", async () => {
    const res = await fetch(`${base}/api/echoheaders`, { headers: { "x-test-probe": "yes" } })
    const json = (await res.json()) as { headers: Record<string, string> }
    expect(json.headers["x-test-probe"]).toBe("yes")
  })

  it("GET /api/big returns body > 100KB", async () => {
    const res = await fetch(`${base}/api/big`)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text.length).toBeGreaterThan(100 * 1024)
  })

  it("GET /api/slow rate-limits at 10 req/s", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => fetch(`${base}/api/slow`)),
    )
    const codes = results.map((r) => r.status)
    const okCount = codes.filter((c) => c === 200).length
    const limitedCount = codes.filter((c) => c === 429).length
    expect(okCount).toBeGreaterThanOrEqual(1)
    expect(limitedCount).toBeGreaterThanOrEqual(1)
  })
})

describe("scenario mode", () => {
  let handle: HttpServerHandle
  let base: string

  beforeAll(async () => {
    handle = await startHttpServer({ scenario: "idor" })
    base = handle.url
  })

  afterAll(async () => {
    await handle.close()
  })

  it("enables /api/users but disables /api/search in idor scenario", async () => {
    const users = await fetch(`${base}/api/users/5`)
    expect(users.status).toBe(200)
    const search = await fetch(`${base}/api/search?q=foo`)
    expect(search.status).toBe(404)
  })
})
