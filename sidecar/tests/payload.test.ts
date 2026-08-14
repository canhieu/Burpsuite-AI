import { describe, it, expect } from "vitest"
import { payloadHandlers } from "../src/handlers/payloads.js"

const handlers = payloadHandlers()
const ctx = undefined as never
const services = undefined as never

function call(method: string, params: Record<string, unknown>): Record<string, unknown> {
  return handlers[method](params, ctx, services) as Record<string, unknown>
}

describe("payload.encode", () => {
  it("url round-trips", () => {
    const r = call("payload.encode", { algorithm: "url", input: "hello world & /path?q=1" })
    expect(decodeURIComponent(String(r["output"]))).toBe("hello world & /path?q=1")
  })

  it("double_url decodes twice", () => {
    const r = call("payload.encode", { algorithm: "double_url", input: "<script>alert(1)</script>" })
    expect(decodeURIComponent(decodeURIComponent(String(r["output"])))).toBe("<script>alert(1)</script>")
  })

  it("base64 round-trips", () => {
    const r = call("payload.encode", { algorithm: "base64", input: "hello" })
    expect(String(r["output"])).toBe("aGVsbG8=")
    expect(Buffer.from(String(r["output"]), "base64").toString()).toBe("hello")
  })

  it("hex round-trips", () => {
    const r = call("payload.encode", { algorithm: "hex", input: "hello" })
    expect(String(r["output"])).toBe("68656c6c6f")
    expect(Buffer.from(String(r["output"]), "hex").toString()).toBe("hello")
  })

  it("json escapes input", () => {
    const r = call("payload.encode", { algorithm: "json", input: 'say "hi"' })
    expect(JSON.parse(String(r["output"]))).toBe('say "hi"')
  })

  it("html encodes entities", () => {
    const r = call("payload.encode", { algorithm: "html", input: '<script>"x"&' })
    expect(String(r["output"])).toBe("&lt;script&gt;&quot;x&quot;&amp;")
  })

  it("unix_time converts", () => {
    const r = call("payload.encode", { algorithm: "unix_time", input: "1700000000" })
    expect(String(r["output"])).toBe("1700000000")
  })

  it("unicode escapes", () => {
    const r = call("payload.encode", { algorithm: "unicode", input: "A" })
    expect(String(r["output"])).toBe("\\u0041")
  })
})

describe("payload.obfuscate", () => {
  for (const technique of ["case", "unicode", "comment_fold", "chunk", "double_encode", "whitespace"]) {
    it(`${technique} returns variants including original`, () => {
      const r = call("payload.obfuscate", { technique, input: "' OR 1=1--" })
      const outputs = r["outputs"] as string[]
      expect(Array.isArray(outputs)).toBe(true)
      expect(outputs.length).toBeGreaterThan(1)
      expect(outputs).toContain("' OR 1=1--")
      expect(new Set(outputs).size).toBe(outputs.length)
    })
  }
})

describe("payload.build", () => {
  const classes = [
    "sqli",
    "xss",
    "ssti",
    "ssrf",
    "xxe",
    "traversal",
    "lfi",
    "cmdi",
    "header_injection",
    "upload_polyglot",
    "jwt_tamper",
  ]
  for (const cls of classes) {
    it(`${cls} returns non-empty payload list`, () => {
      const r = call("payload.build", { class: cls })
      const payloads = r["payloads"] as string[]
      expect(payloads.length).toBeGreaterThan(0)
      for (const p of payloads) expect(typeof p).toBe("string")
    })
  }

  it("substitutes into template placeholder", () => {
    const r = call("payload.build", { class: "sqli", template: "id={}" })
    const payloads = r["payloads"] as string[]
    expect(payloads.every((p) => p.startsWith("id="))).toBe(true)
  })
})

describe("crypto.jwt", () => {
  const token =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJ1c2VyIiwiaWF0IjoxNzAwMDAwMDAwfQ.signature"

  it("analyzes header and payload", () => {
    const r = call("crypto.jwt.analyze", { token }) as { header: Record<string, unknown>; payload: Record<string, unknown>; alg: string; possibleIssues: string[] }
    expect(r.alg).toBe("HS256")
    expect(r.payload).toMatchObject({ sub: "admin", role: "user" })
    expect(r.possibleIssues).toContain("no exp claim")
  })

  it("detects alg none", () => {
    const none = b64url('{"alg":"none"}') + "." + b64url('{"sub":"x"}') + "."
    const r = call("crypto.jwt.analyze", { token: none })
    expect(r["alg"]).toBe("none")
    expect(r["possibleIssues"]).toContain("algorithm is none")
  })

  it("forges alg none and weak-hmac tokens", () => {
    const r = call("crypto.jwt.forge", { token, mutations: { claims: { role: "admin" } } }) as { tokens: string[] }
    expect(r.tokens.length).toBeGreaterThan(0)
    const hasNone = r.tokens.some((t) => JSON.parse(Buffer.from(t.split(".")[0], "base64url").toString()).alg === "none")
    expect(hasNone).toBe(true)
    for (const t of r.tokens) expect(t.split(".").length).toBe(3)
  })
})

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url")
}
