import type { HandlerGroup } from "./types.js"
import type { AnalysisEngine, AnalysisItem } from "../analysis/analyzer.js"

export function analysisHandlers(engine: AnalysisEngine): HandlerGroup {
  return {
    "analysis.submit": (params) => {
      const item: AnalysisItem = {
        fingerprint: String(params["fingerprint"] ?? ""),
        method: String(params["method"] ?? "GET"),
        url: String(params["url"] ?? ""),
        status: Number(params["status"] ?? 0),
        score: Number(params["score"] ?? 0),
        flags: Array.isArray(params["flags"]) ? (params["flags"] as unknown[]).map(String) : [],
        reflection: typeof params["reflection"] === "string" ? params["reflection"] : undefined,
        requestDigest: String(params["requestDigest"] ?? ""),
        responseDigest: String(params["responseDigest"] ?? ""),
      }
      if (!item.fingerprint || !item.url) throw new Error("analysis.submit requires fingerprint + url")
      const queued = engine.submit(item)
      return { queued, queueLength: queued ? 1 : 0 }
    },
  }
}
