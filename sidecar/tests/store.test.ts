import { describe, it, expect } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStore, type Store } from "../src/store.js"
import type { Finding, Evidence } from "../src/types.js"

function tempStore(): Store {
  return createStore(mkdtempSync(join(tmpdir(), "sidecar-store-")))
}

const sampleFinding: Finding = {
  id: "fnd_1",
  title: "SQL injection in /search",
  vulnClass: "sqli",
  severity: "high",
  confidence: "medium",
  status: "candidate",
  assets: ["https://example.com/search"],
  evidence: [],
}

describe("store findings", () => {
  it("creates and reads a finding", () => {
    const s = tempStore()
    s.createFinding(sampleFinding)
    const got = s.getFinding("fnd_1")
    expect(got).toMatchObject({ id: "fnd_1", title: "SQL injection in /search", severity: "high" })
  })

  it("lists findings with filters", () => {
    const s = tempStore()
    s.createFinding(sampleFinding)
    s.createFinding({ ...sampleFinding, id: "fnd_2", severity: "low", status: "validated", program: "acme" })
    expect(s.listFindings().length).toBe(2)
    expect(s.listFindings({ status: "validated" }).map((f) => f.id)).toEqual(["fnd_2"])
    expect(s.listFindings({ program: "acme" }).map((f) => f.id)).toEqual(["fnd_2"])
    expect(s.listFindings({ status: "candidate" }).map((f) => f.id)).toEqual(["fnd_1"])
  })

  it("updates a finding", () => {
    const s = tempStore()
    s.createFinding(sampleFinding)
    s.updateFinding({ ...sampleFinding, status: "confirmed" })
    expect(s.getFinding("fnd_1")?.status).toBe("confirmed")
  })

  it("pins and reads evidence", () => {
    const s = tempStore()
    s.createFinding(sampleFinding)
    const ev: Evidence = { kind: "request-response", refs: [{ projectId: "p", source: "proxy", id: 1 }], redactedPayload: "{{redacted:authorization}}", timestamp: Date.now() }
    const id = s.pinEvidence("fnd_1", ev)
    expect(id).toBeTruthy()
    const list = s.getEvidence("fnd_1")
    expect(list.length).toBe(1)
    expect(list[0].evidence.redactedPayload).toBe("{{redacted:authorization}}")
  })
})

describe("store runs", () => {
  it("persists and reloads a run", () => {
    const s = tempStore()
    s.saveRun("run_1", { status: "running", task: "recon" })
    const got = s.getRun("run_1")
    expect(got).toBeDefined()
    expect(got?.data).toMatchObject({ status: "running", task: "recon" })
    expect(s.listRuns().length).toBe(1)
  })

  it("updates existing run", () => {
    const s = tempStore()
    s.saveRun("run_1", { status: "running" })
    s.saveRun("run_1", { status: "completed" })
    expect(s.getRun("run_1")?.status).toBe("completed")
    expect(s.listRuns().length).toBe(1)
  })
})

describe("store tool_log", () => {
  it("writes and reads log entries", () => {
    const s = tempStore()
    s.logTool("http.send", { statusCode: 200, bodyTruncated: false })
    s.logTool("payload.build", { payloads: 11 })
    const log = s.getToolLog()
    expect(log.length).toBe(2)
    expect(log[0].tool).toBe("payload.build")
    expect(log[0].result).toMatchObject({ payloads: 11 })
  })
})

describe("store messages + settings", () => {
  it("stores message refs with summaries", () => {
    const s = tempStore()
    s.putMessage({ projectId: "p", source: "proxy", id: 99 }, "GET /login 200")
    const got = s.getMessage({ projectId: "p", source: "proxy", id: 99 })
    expect(got?.summary).toBe("GET /login 200")
    expect(s.searchMessages({ projectId: "p" }).length).toBe(1)
    expect(s.searchMessages({ text: "login" }).length).toBe(1)
  })

  it("round-trips settings", () => {
    const s = tempStore()
    s.setSetting("scope", ["*.example.com"])
    s.setSetting("nested", { a: { b: 1 } })
    expect(s.getSetting("scope")).toEqual(["*.example.com"])
    expect(s.getSetting("nested")).toEqual({ a: { b: 1 } })
    expect(s.getAllSettings()).toMatchObject({ scope: ["*.example.com"] })
  })
})
