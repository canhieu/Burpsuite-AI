import type { ProviderRegistry } from "../providers.js"
import { streamFromRegistry } from "../providers.js"
import type { SidecarConfig } from "../config.js"

export interface AnalysisItem {
  fingerprint: string
  method: string
  url: string
  status: number
  score: number
  flags: string[]
  reflection?: string
  requestDigest: string
  responseDigest: string
}

export interface AnalysisResult {
  level: "info" | "low" | "medium" | "high" | "critical"
  vulnClass: string
  confidence: number
  summary: string
  nextStep: string
}

const LEVEL_ORDER = ["info", "low", "medium", "high", "critical"]

const SYSTEM_PROMPT = `You are an HTTP security triage analyst for authorized pentesting.
Given a request/response pair, decide whether it reveals a potential vulnerability.
Output ONLY a single JSON object, nothing else, no markdown, no code fences:
{"level":"info|low|medium|high|critical","vulnClass":"sqli|xss|idor|ssrf|ssti|path-traversal|open-redirect|information-disclosure|auth|other|none","confidence":0-100,"summary":"one sentence","nextStep":"one concrete next test to run"}
Rules:
- Level reflects exploit likelihood, not just presence of flags.
- "none" vulnClass + low confidence when nothing notable.
- Never fabricate; base only on the data given.
- nextStep must be a concrete HTTP test (parameter, endpoint).`

const USER_PROMPT_TEMPLATE = `Analyze this request/response for potential vulnerabilities.

META: {meta}

FULL REQUEST:
{digest.requestDigest}

FULL RESPONSE:
{digest.responseDigest}`

export class AnalysisEngine {
  private cache = new Map<string, { at: number; result: AnalysisResult | "pending" }>()
  private lastCall = 0
  private minIntervalMs: number
  private maxPerMinute: number
  private windowCalls: number[] = []
  private running = false
  private queue: AnalysisItem[] = []
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private registry: ProviderRegistry,
    private config: SidecarConfig,
    private emit: (method: string, params: Record<string, unknown>) => void,
    private log: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void,
  ) {
    this.minIntervalMs = 1000
    this.maxPerMinute = 30
    this.timer = setInterval(() => this.drain(), 5000)
    this.timer.unref?.()
  }

  submit(item: AnalysisItem): boolean {
    if (!this.config.providers[this.config.models.roles.fast.provider]?.enabled) return false
    const cached = this.cache.get(item.fingerprint)
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return false
    this.cache.set(item.fingerprint, { at: Date.now(), result: "pending" })
    this.queue.push(item)
    void this.drain()
    return true
  }

  private rateLimited(): boolean {
    const now = Date.now()
    if (now - this.lastCall < this.minIntervalMs) return true
    this.windowCalls = this.windowCalls.filter((t) => now - t < 60_000)
    if (this.windowCalls.length >= this.maxPerMinute) return true
    return false
  }

  private async drain() {
    if (this.running || this.queue.length === 0) return
    this.running = true
    try {
      while (this.queue.length > 0 && !this.rateLimited()) {
        const item = this.queue.shift()!
        try {
          const result = await this.analyze(item)
          this.cache.set(item.fingerprint, { at: Date.now(), result })
          this.emit("analysis.entry", { fingerprint: item.fingerprint, url: item.url, method: item.method, status: item.status, score: item.score, ...result })
        } catch (e) {
          this.cache.delete(item.fingerprint)
          this.log("warn", `analysis failed: ${(e as Error).message}`, { url: item.url })
        }
      }
    } finally {
      this.running = false
    }
  }

  private async analyze(item: AnalysisItem): Promise<AnalysisResult> {
    this.lastCall = Date.now()
    this.windowCalls.push(this.lastCall)
    const role = this.config.models.roles.fast
    const reqMeta = {
      method: item.method,
      url: item.url,
      status: item.status,
      score: item.score,
      flags: item.flags,
      reflection: item.reflection,
    }
    const messages = [
      { role: "system" as const, content: SYSTEM_PROMPT },
      {
        role: "user" as const,
        content: USER_PROMPT_TEMPLATE
          .replace("{meta}", JSON.stringify(reqMeta))
          .replace("{digest.requestDigest}", item.requestDigest)
          .replace("{digest.responseDigest}", item.responseDigest),
      },
    ]
    const iter = await streamFromRegistry(this.registry, messages, {
      provider: role.provider,
      model: role.model,
      stream: { maxTokens: 1200, reasoningEffort: "low" },
    })
    let text = ""
    for await (const ev of iter) {
      if (ev.type === "text") text += String(ev.data)
      if (ev.type === "error") throw new Error(String(ev.data))
    }
    return parseResult(text)
  }

  shutdown() {
    if (this.timer) clearInterval(this.timer)
    this.queue = []
  }
}

export function parseResult(text: string): AnalysisResult {
  const trimmed = text.trim()
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  let json = start >= 0 && end > start ? trimmed.substring(start, end + 1) : trimmed
  let parsed: Record<string, unknown> | null = null
  for (const attempt of [json, json.replace(/,\s*([}\]])/g, "$1").replace(/'([^']*)'/g, '"$1"')]) {
    try {
      parsed = JSON.parse(attempt)
      break
    } catch {
      // try next normalization
    }
  }
  if (!parsed) {
    // model drifted into prose: degrade gracefully
    const firstLine = trimmed.split("\n").find((l) => l.trim().length > 20)?.trim().slice(0, 200) ?? trimmed.slice(0, 200)
    return {
      level: "info",
      vulnClass: "unknown",
      confidence: 0,
      summary: firstLine,
      nextStep: "",
    }
  }
  const level = String(parsed["level"] ?? "info").toLowerCase()
  const safeLevel = LEVEL_ORDER.includes(level) ? (level as AnalysisResult["level"]) : "info"
  const confidence = Number(parsed["confidence"])
  return {
    level: safeLevel,
    vulnClass: String(parsed["vulnClass"] ?? "unknown"),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(100, Math.round(confidence))) : 0,
    summary: String(parsed["summary"] ?? "").slice(0, 300),
    nextStep: String(parsed["nextStep"] ?? "").slice(0, 300),
  }
}
