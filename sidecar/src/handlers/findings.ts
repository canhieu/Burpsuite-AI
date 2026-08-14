import type { Finding } from "../types.js"
import { newId } from "../util.js"
import { RpcError } from "./types.js"
import type { HandlerGroup } from "./types.js"

function validateFinding(f: unknown): asserts f is Finding {
  if (!f || typeof f !== "object") throw new Error("finding.create requires a finding object")
  const obj = f as Record<string, unknown>
  for (const key of ["title", "vulnClass", "severity", "confidence", "status"]) {
    if (typeof obj[key] !== "string") throw new Error(`finding requires string field: ${key}`)
  }
}

export function findingHandlers(): HandlerGroup {
  return {
    "finding.create": (params, _c, services) => {
      const f = params["finding"] as Finding
      validateFinding(f)
      const finding: Finding = {
        id: f.id || newId("fnd_"),
        title: f.title,
        vulnClass: f.vulnClass,
        severity: f.severity,
        confidence: f.confidence,
        status: f.status ?? "candidate",
        chain: f.chain,
        skill: f.skill,
        runId: f.runId,
        program: f.program,
        assets: f.assets,
        evidence: f.evidence ?? [],
      }
      if (services.store.getFinding(finding.id)) throw new RpcError(409, `finding already exists: ${finding.id}`)
      services.store.createFinding(finding)
      services.log("info", `finding created: ${finding.id} ${finding.title}`)
      return { id: finding.id }
    },
    "finding.update": (params, _c, services) => {
      const f = params["finding"] as Finding
      validateFinding(f)
      const existing = services.store.getFinding(f.id)
      if (!existing) throw new RpcError(404, `finding not found: ${f.id}`)
      services.store.updateFinding({ ...existing, ...f, id: existing.id })
      services.log("info", `finding updated: ${f.id}`)
      return { ok: true, id: f.id }
    },
    "finding.list": (params, _c, services) => {
      const status = typeof params["status"] === "string" ? params["status"] : undefined
      const program = typeof params["program"] === "string" ? params["program"] : undefined
      return { findings: services.store.listFindings({ status, program }) }
    },
    "finding.validate": (params, _c, services) => {
      const id = String(params["id"] ?? "")
      const finding = services.store.getFinding(id)
      if (!finding) throw new RpcError(404, `finding not found: ${id}`)
      return {
        verdict: "candidate",
        reasons: ["validation gates pending"],
      }
    },
  }
}
