import type { Evidence } from "../types.js"
import { RpcError } from "./types.js"
import type { HandlerGroup } from "./types.js"
import { redactRequest, redactResponse } from "../redact.js"
import type { HttpMessage } from "../types.js"

function toHarEntry(evidence: Evidence): Record<string, unknown> {
  const refs = evidence.refs ?? []
  const request: HttpMessage = { startLine: "GET / HTTP/1.1", headers: {} }
  const response: HttpMessage = { startLine: "HTTP/1.1 200 OK", headers: {} }
  const requestRedacted = redactRequest(request)
  const responseRedacted = redactResponse(response)
  return {
    startedDateTime: new Date(evidence.timestamp).toISOString(),
    time: 0,
    request: {
      method: requestRedacted.startLine.split(" ")[0] ?? "GET",
      url: requestRedacted.startLine.split(" ")[1] ?? "unknown",
      httpVersion: "HTTP/1.1",
      headers: Object.entries(requestRedacted.headers).map(([name, value]) => ({ name, value })),
      bodySize: -1,
    },
    response: {
      status: 0,
      statusText: "",
      httpVersion: "HTTP/1.1",
      headers: Object.entries(responseRedacted.headers).map(([name, value]) => ({ name, value })),
      content: { text: evidence.redactedPayload ?? "", size: (evidence.redactedPayload ?? "").length },
      bodySize: (evidence.redactedPayload ?? "").length,
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
    _refs: refs,
  }
}

export function evidenceHandlers(): HandlerGroup {
  return {
    "evidence.pin": (params, _c, services) => {
      const findingId = String(params["findingId"] ?? "")
      const ev = params["evidence"] as Evidence
      if (!services.store.getFinding(findingId)) throw new RpcError(404, `finding not found: ${findingId}`)
      if (!ev || typeof ev !== "object") throw new Error("evidence.pin requires evidence object")
      const evidence: Evidence = {
        kind: ev.kind ?? "request-response",
        refs: ev.refs ?? [],
        redactedPayload: ev.redactedPayload,
        timestamp: ev.timestamp ?? Date.now(),
      }
      const id = services.store.pinEvidence(findingId, evidence)
      return { id }
    },
    "evidence.export": (params, _c, services) => {
      const findingId = String(params["findingId"] ?? "")
      const format = String(params["format"] ?? "json")
      const finding = services.store.getFinding(findingId)
      if (!finding) throw new RpcError(404, `finding not found: ${findingId}`)
      const records = services.store.getEvidence(findingId)
      const evidences = records.map((r) => r.evidence)

      if (format === "har") {
        const har = {
          log: {
            version: "1.2",
            creator: { name: "burp-agent-sidecar", version: "0.1.0" },
            entries: evidences.map(toHarEntry),
          },
        }
        return { content: JSON.stringify(har, null, 2), format }
      }
      if (format === "markdown") {
        const lines: string[] = [`# Evidence: ${finding.title}`, ""]
        for (const r of records) {
          lines.push(`## ${r.id} (${r.evidence.kind})`, "")
          lines.push(`- refs: ${r.evidence.refs?.map((rf) => `${rf.source}:${rf.id}`).join(", ") ?? "none"}`)
          lines.push(`- timestamp: ${new Date(r.evidence.timestamp).toISOString()}`)
          if (r.evidence.redactedPayload) {
            lines.push("", "```text", r.evidence.redactedPayload, "```")
          }
          lines.push("")
        }
        return { content: lines.join("\n"), format }
      }
      return { content: JSON.stringify(evidences, null, 2), format }
    },
  }
}
