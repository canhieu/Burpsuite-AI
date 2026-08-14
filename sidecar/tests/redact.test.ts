import { describe, it, expect } from "vitest"
import { redactHeaders, redactRequest, redactResponse, redactBody, isSensitiveHeader, shouldRedact } from "../src/redact.js"

describe("redact", () => {
  it("masks Authorization header", () => {
    const out = redactHeaders({ Authorization: "Bearer abc.def.ghi" })
    expect(out["Authorization"]).toBe("{{redacted:authorization}}")
  })

  it("masks Cookie header values individually", () => {
    const out = redactHeaders({ Cookie: "session=abc123; theme=dark" })
    expect(out["Cookie"]).toBe("session={{redacted:cookie}}; theme={{redacted:cookie}}")
  })

  it("masks Set-Cookie and Proxy-Authorization", () => {
    const out = redactHeaders({ "Set-Cookie": "session=xyz", "Proxy-Authorization": "Basic dXNlcg==" })
    expect(out["Set-Cookie"]).toBe("session={{redacted:set-cookie}}")
    expect(out["Proxy-Authorization"]).toBe("{{redacted:proxy-authorization}}")
  })

  it("masks headers matching token/api-key/password/secret patterns", () => {
    const out = redactHeaders({ "X-Api-Key": "sk-123", "X-Password": "hunter2", "X-Token": "t", "Authorization-Token": "z" })
    expect(out["X-Api-Key"]).toBe("{{redacted:X-Api-Key}}")
    expect(out["X-Password"]).toBe("{{redacted:X-Password}}")
    expect(out["X-Token"]).toBe("{{redacted:X-Token}}")
    expect(out["Authorization-Token"]).toBe("{{redacted:Authorization-Token}}")
  })

  it("leaves normal headers unchanged", () => {
    const out = redactHeaders({ Host: "example.com", "User-Agent": "test", "Content-Type": "application/json", "X-Request-Id": "123" })
    expect(out).toEqual({ Host: "example.com", "User-Agent": "test", "Content-Type": "application/json", "X-Request-Id": "123" })
  })

  it("redactRequest/redactResponse redact headers and sensitive body keys", () => {
    const req = { startLine: "POST /login HTTP/1.1", headers: { Cookie: "session=s1" }, body: '{"password":"hunter2","user":"bob"}' }
    const out = redactRequest(req)
    expect(out.headers["Cookie"]).toContain("{{redacted:cookie}}")
    expect(out.body).toContain('"password":"{{redacted:password}}"')
    expect(out.body).toContain('"user":"bob"')

    const res = redactResponse({ startLine: "HTTP/1.1 200 OK", headers: { "Set-Cookie": "sid=1" }, body: "ok" })
    expect(res.headers["Set-Cookie"]).toContain("{{redacted:set-cookie}}")
  })

  it("redactBody masks bearer tokens in text", () => {
    const out = redactBody("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig")
    expect(out).not.toContain("eyJhbGci")
    expect(out).toContain("{{redacted:Authorization}}")
  })

  it("isSensitiveHeader detects sensitive names", () => {
    expect(isSensitiveHeader("Authorization")).toBe(true)
    expect(isSensitiveHeader("cookie")).toBe(true)
    expect(isSensitiveHeader("X-Token")).toBe(true)
    expect(isSensitiveHeader("X-ApiKey")).toBe(true)
    expect(isSensitiveHeader("X-Password")).toBe(true)
    expect(isSensitiveHeader("X-Secret")).toBe(true)
    expect(isSensitiveHeader("User-Agent")).toBe(false)
  })

  it("redacts by default, honors explicit redacted:false", () => {
    expect(shouldRedact(undefined)).toBe(true)
    expect(shouldRedact({})).toBe(true)
    expect(shouldRedact({ redacted: true })).toBe(true)
    expect(shouldRedact({ redacted: false })).toBe(false)
  })
})
