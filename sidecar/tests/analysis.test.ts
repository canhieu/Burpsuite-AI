import { describe, it, expect } from "vitest"
import { AnalysisEngine, parseResult } from "../src/analysis/analyzer.js"

class FakeRegistry {
  statuses = async () => []
  all = () => [{ provider: "shineshop", baseUrl: "x", hasKey: true }]
  get = (name: string) => {
    if (name !== "shineshop") return undefined
    return {
      provider: "shineshop",
      baseUrl: "x",
      hasKey: true,
      stream: async function* () {
        yield { type: "text", data: `{"level":"high","vulnClass":"reflected-xss","confidence":82,"summary":"param echoed","nextStep":"test <script> in q"}` }
        yield { type: "done", data: { finishReason: "stop" } }
      },
    }
  }
  resolveModel = (m: string) => ({ provider: "shineshop", id: m })
}

describe("analysis.analyzer", () => {
  it("parseResult extracts structured JSON", () => {
    const r = parseResult('Some text {"level":"medium","vulnClass":"idor","confidence":70,"summary":"id guessable","nextStep":"iterate id"} tail')
    expect(r.level).toBe("medium")
    expect(r.vulnClass).toBe("idor")
    expect(r.confidence).toBe(70)
    expect(r.nextStep).toContain("iterate")
  })

  it("parseResult tolerates single-quote drift", () => {
    const r = parseResult("{'level':'low','vulnClass':'info','confidence':30,'summary':'ok','nextStep':'none'}")
    expect(r.level).toBe("low")
    expect(r.confidence).toBe(30)
  })

  it("parseResult clamps invalid levels + confidence", () => {
    const r = parseResult('{"level":"catastrophic","vulnClass":"x","confidence":999,"summary":"s","nextStep":"n"}')
    expect(r.level).toBe("info")
    expect(r.confidence).toBe(100)
  })

  it("engine emits entry and dedupes by fingerprint", async () => {
    const cfg = {
      models: { roles: { fast: { provider: "shineshop", model: "deepseek-v4-flash" } } },
      providers: { shineshop: { enabled: true, baseUrl: "x", apiKey: "k" } },
    } as never
    const emitted: Array<Record<string, unknown>> = []
    const eng = new AnalysisEngine(new FakeRegistry() as never, cfg, (m, p) => emitted.push(p), () => {})
    const item = {
      fingerprint: "GET /api/u?id=1 #abc",
      method: "GET",
      url: "https://tgt.test/api/u?id=1",
      status: 200,
      score: 8,
      flags: ["reflection"],
      requestDigest: "GET /api/u?id=1",
      responseDigest: "HTTP/1.1 200 OK\necho 1",
    }
    expect(eng.submit(item)).toBe(true)
    expect(eng.submit(item)).toBe(false) // dedupe
    // drain synchronously
    await new Promise((r) => setTimeout(r, 100))
    expect(emitted.length).toBe(1)
    const e = emitted[0]
    expect(e["url"]).toBe("https://tgt.test/api/u?id=1")
    expect(e["level"]).toBe("high")
    eng.shutdown()
  })

  it("engine rejects when fast provider disabled", () => {
    const cfg = {
      models: { roles: { fast: { provider: "shineshop", model: "deepseek-v4-flash" } } },
      providers: { shineshop: { enabled: false, baseUrl: "x" } },
    } as never
    const eng = new AnalysisEngine(new FakeRegistry() as never, cfg, () => {}, () => {})
    const item = {
      fingerprint: "fp",
      method: "GET",
      url: "https://tgt.test/a",
      status: 200,
      score: 9,
      flags: [],
      requestDigest: "x",
      responseDigest: "y",
    }
    expect(eng.submit(item)).toBe(false)
    eng.shutdown()
  })
})
