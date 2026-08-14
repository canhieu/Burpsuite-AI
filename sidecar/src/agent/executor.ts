import type { ChatMessage, ProviderEvent } from "../providers.js"
import type { SkillManifest, ToolCall } from "../types.js"
import type { PlanItem, RunConfig, ToolCallFrame } from "./types.js"
import type { FindingDraft, ExecutorStatus } from "./types.js"
import type { ToolBridge } from "./rpc-bridge.js"
import { TOOL_SCHEMA } from "./tool-schema.js"
import { BudgetTracker, Semaphore } from "./budget.js"
import type { PauseGate } from "./pause-gate.js"

export interface ModelClient {
  stream(
    messages: ChatMessage[],
    opts?: {
      model?: string
      provider?: string
      signal?: AbortSignal
      onUsage?: (usage: unknown) => void
    },
  ): AsyncIterable<ProviderEvent>
}

export interface ApprovalGate {
  requestApproval(call: ToolCall, reason: string, risk: string): Promise<boolean>
}

export interface ExecutorCallbacks {
  emit(method: string, params: Record<string, unknown>): void
}

export interface ExecutorContext {
  runId: string
  executorId: string
  item: PlanItem
  skill?: SkillManifest
  config: RunConfig
  model: ModelClient
  bridge: ToolBridge
  budget: BudgetTracker
  semaphore: Semaphore
  approvals: ApprovalGate
  cb: ExecutorCallbacks
  signal: AbortSignal
  gate: PauseGate
  isCancelled: () => boolean
  historyWindow: number
  costModel: Record<string, { inputPerMtok?: number; outputPerMtok?: number }>
}

export interface ExecutorResult {
  status: ExecutorStatus
  requestsUsed: number
  tokenUsed: number
  costUsd: number
  findings: FindingDraft[]
  error?: string
}

interface ModelOutput {
  type: "tool_call" | "conclusion"
  call?: ToolCall
  text: string
  tokens: number
}

const ALWAYS_APPROVE = new Set([
  "scope.add",
  "scope.remove",
  "config.import",
  "proxy.set_intercept",
  "bchecks.register",
  "scan.check.register",
  "scan.report",
  "report.generate",
  "mcp.call",
  "mcp.server.add",
  "mcp.server.remove",
])

const MUTATING_TOOLS = new Set([
  "http.batch",
  "http.race",
  "mutate.apply",
  "websocket.create",
  "websocket.send",
  "site_map.add",
  "scope.add",
  "scope.remove",
  "config.import",
  "proxy.set_intercept",
  "bchecks.register",
  "scan.check.register",
  "finding.create",
  "finding.update",
  "report.generate",
  "vault.set",
  "mcp.call",
  "mcp.server.add",
  "mcp.server.remove",
])

const MUTATING_PREFIXES = ["scan.", "tool.", "websocket."]

export function isMutatingTool(method: string, args: Record<string, unknown>): boolean {
  if (MUTATING_TOOLS.has(method)) return true
  if (MUTATING_PREFIXES.some((p) => method.startsWith(p))) return true
  if (method === "http.send") {
    const req = (args["request"] as Record<string, unknown> | undefined) ?? {}
    const m = String(req["method"] ?? args["method"] ?? "").toUpperCase()
    return m !== "" && m !== "GET" && m !== "HEAD"
  }
  return false
}

export function isBudgetTool(method: string): boolean {
  return method === "http.send" || method === "http.batch" || method === "http.race" || method.startsWith("scan.")
}

export function riskLevel(method: string): string {
  if (/delete|remove|import|set_intercept/.test(method)) return "critical"
  if (method.startsWith("scan.") || method.startsWith("tool.")) return "high"
  return "medium"
}

export function approvalDecision(
  mode: string,
  skill: SkillManifest | undefined,
  call: ToolCall,
): { required: boolean; reason: string; risk: string } {
  const method = call.name
  const args = call.arguments ?? {}
  if (ALWAYS_APPROVE.has(method)) {
    return { required: true, reason: `approval required for ${method}`, risk: riskLevel(method) }
  }
  if (skill?.approvalPolicy === "approval") {
    return { required: true, reason: `skill requires approval for ${method}`, risk: riskLevel(method) }
  }
  if (mode === "manual") {
    if (method === "http.send" || isMutatingTool(method, args)) {
      return { required: true, reason: `manual mode requires approval for ${method}`, risk: riskLevel(method) }
    }
    return { required: false, reason: "", risk: "low" }
  }
  if (mode === "smart") {
    if (isMutatingTool(method, args)) {
      return { required: true, reason: `smart mode requires approval for ${method}`, risk: riskLevel(method) }
    }
    return { required: false, reason: "", risk: "low" }
  }
  return { required: false, reason: "", risk: "low" }
}

export function estimateTokens(usage: unknown): number {
  if (!usage || typeof usage !== "object") return 0
  const u = usage as Record<string, unknown>
  const input =
    typeof u["prompt_tokens"] === "number"
      ? (u["prompt_tokens"] as number)
      : typeof u["input_tokens"] === "number"
        ? (u["input_tokens"] as number)
        : 0
  const output =
    typeof u["completion_tokens"] === "number"
      ? (u["completion_tokens"] as number)
      : typeof u["output_tokens"] === "number"
        ? (u["output_tokens"] as number)
        : 0
  return input + output
}

export function estimateCost(
  tokens: number,
  model: string | undefined,
  costModel: Record<string, { inputPerMtok?: number; outputPerMtok?: number }>,
): number {
  if (!model) return 0
  for (const [key, rates] of Object.entries(costModel)) {
    if (model.includes(key)) {
      const input = rates.inputPerMtok ?? 0
      const output = rates.outputPerMtok ?? input
      return (tokens / 1_000_000) * ((input + output) / 2)
    }
  }
  return 0
}

function extractJsonBlocks(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  let inStr = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (escape) escape = false
      else if (ch === "\\") escape = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === "{" || ch === "[") {
      if (depth === 0) start = i
      depth++
    } else if (ch === "}" || ch === "]") {
      depth--
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }
  return out
}

export function parseToolCall(text: string): ToolCall | undefined {
  for (const block of extractJsonBlocks(text)) {
    try {
      const parsed = JSON.parse(block) as Record<string, unknown>
      const tc = parsed["tool_call"]
      if (tc && typeof tc === "object") {
        const t = tc as Record<string, unknown>
        const name = typeof t["name"] === "string" ? t["name"] : undefined
        if (name) {
          return {
            name,
            arguments: t["arguments"] && typeof t["arguments"] === "object" ? (t["arguments"] as Record<string, unknown>) : {},
          }
        }
      }
    } catch {
      /* keep scanning */
    }
  }
  return undefined
}

export function parseConclusion(text: string, endpoint: string): { conclusion: string; finding?: FindingDraft } {
  const trimmed = text.trim()
  let obj: Record<string, unknown> | undefined
  for (const block of extractJsonBlocks(trimmed)) {
    try {
      const parsed = JSON.parse(block)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>
        break
      }
    } catch {
      /* keep scanning */
    }
  }
  if (obj) {
    const conclusion = typeof obj["conclusion"] === "string" ? obj["conclusion"] : trimmed
    const f = obj["finding"]
    if (f && typeof f === "object") {
      const fd = f as Record<string, unknown>
      const title = typeof fd["title"] === "string" ? fd["title"] : ""
      const vulnClass = typeof fd["vulnClass"] === "string" ? fd["vulnClass"] : typeof fd["vuln_class"] === "string" ? String(fd["vuln_class"]) : ""
      if (title && vulnClass) {
        return {
          conclusion,
          finding: {
            title,
            vulnClass,
            severity: typeof fd["severity"] === "string" ? fd["severity"] : "info",
            confidence: typeof fd["confidence"] === "string" ? fd["confidence"] : "tentative",
            detail: typeof fd["detail"] === "string" ? fd["detail"] : conclusion,
            endpoint,
          },
        }
      }
    }
    return { conclusion, finding: undefined }
  }
  return { conclusion: trimmed, finding: undefined }
}

function buildSystemPrompt(ctx: ExecutorContext): string {
  const lines = [
    "You are a security testing agent operating through Burp Suite tool calls.",
    `Mode: ${ctx.config.mode}.`,
  ]
  if (ctx.skill?.prompt) lines.push(`Skill: ${ctx.skill.prompt}`)
  else if (ctx.skill?.name) lines.push(`Skill: ${ctx.skill.name}`)
  if (ctx.skill?.limits) {
    const l = ctx.skill.limits
    lines.push(`Skill limits: requests=${l.requests ?? "unset"} durationSeconds=${l.durationSeconds ?? "unset"} concurrency=${l.concurrency ?? "unset"}`)
  }
  if (ctx.skill?.tools) {
    lines.push(`Tool allow: ${(ctx.skill.tools.allow ?? []).join(",") || "all"}`)
    if (ctx.skill.tools.deny?.length) lines.push(`Tool deny: ${ctx.skill.tools.deny.join(",")}`)
  }
  if (ctx.config.scope?.length) lines.push(`Scope: ${ctx.config.scope.join(", ")}`)
  lines.push("You may only perform authorized testing within the given scope.")
  lines.push('To invoke a tool, respond with exactly one JSON object: {"tool_call": {"name": "<tool>", "arguments": {}}}.')
  lines.push(TOOL_SCHEMA)
  lines.push(
    'When the objective is FULLY achieved, respond with {"conclusion": "..."} or {"conclusion": "...", "finding": {"title": "...", "vulnClass": "...", "severity": "low|medium|high|critical", "confidence": "tentative|medium|high|certain"}}.',
  )
  lines.push(
    "Tools are grouped by prefix, e.g. history.search, http.send, payload.build, finding.create, scan.crawl, oob.session.",
  )
  lines.push(
    "You MUST keep calling tools step by step until the objective is fully achieved. NEVER conclude after a single request.",
  )
  lines.push(
    "After every tool result, study it and immediately plan+execute the next tool call. If a request errored, debug and retry with a corrected payload.",
  )
  lines.push("Tool results are redacted; never reveal or echo secrets. Never retry the same idempotencyKey.")
  return lines.join("\n")
}

function buildUserPrompt(ctx: ExecutorContext): string {
  const endpoint = ctx.item.endpoint || "(whole target)"
  const task = ctx.item.hypothesis || ctx.config.task
  const overall = ctx.config.task && ctx.item.hypothesis ? `\nOverall task: ${ctx.config.task}` : ""
  return `Endpoint: ${endpoint}\nTask: ${task}${overall}`
}

function buildMessages(ctx: ExecutorContext, history: ToolCallFrame[]): ChatMessage[] {
  const sys: ChatMessage = { role: "system", content: buildSystemPrompt(ctx) }
  const user: ChatMessage = { role: "user", content: buildUserPrompt(ctx) }
  const frames: ChatMessage[] = []
  for (const f of history) {
    frames.push({ role: "assistant", content: JSON.stringify({ tool_call: { name: f.call.name, arguments: f.call.arguments } }) })
    frames.push({ role: "user", content: `<tool_result>\n${JSON.stringify(f.result)}\n</tool_result>` })
  }
  return [sys, user, ...frames]
}

async function callModel(
  client: ModelClient,
  messages: ChatMessage[],
  opts: { model?: string; provider?: string },
  signal: AbortSignal,
  ctx?: Pick<ExecutorContext, "runId" | "cb">,
): Promise<ModelOutput> {
  let text = ""
  let tokens = 0
  let nativeCall: ToolCall | undefined
  const onUsage = (usage: unknown) => {
    tokens += estimateTokens(usage)
  }
  const iter = client.stream(messages, { model: opts.model, provider: opts.provider, signal, onUsage })
  for await (const ev of iter) {
    if (ev.type === "text") {
      text += String(ev.data)
      if (ctx) ctx.cb.emit("agent.event", { runId: ctx.runId, type: "text", data: String(ev.data) })
    } else if (ev.type === "tool_call") {
      const d = ev.data as { name?: string; arguments?: string | Record<string, unknown> }
      if (d && d.name) {
        nativeCall = {
          name: d.name,
          arguments:
            typeof d.arguments === "string"
              ? (safeParseJson(d.arguments) as Record<string, unknown>)
              : d.arguments ?? {},
        }
      }
    } else if (ev.type === "error") {
      throw new Error(`model error: ${String(ev.data)}`)
    }
  }
  if (nativeCall) return { type: "tool_call", call: nativeCall, text, tokens }
  const tc = parseToolCall(text)
  if (tc) return { type: "tool_call", call: tc, text, tokens }
  return { type: "conclusion", text, tokens }
}

function safeParseJson(input: string): unknown {
  try {
    return JSON.parse(input)
  } catch {
    return {}
  }
}

export async function runExecutor(ctx: ExecutorContext): Promise<ExecutorResult> {
  const state: ExecutorResult = { status: "running", requestsUsed: 0, tokenUsed: 0, costUsd: 0, findings: [] }
  const history: ToolCallFrame[] = []
  const window = ctx.historyWindow
  const modelOpt = { model: ctx.config.models?.executor?.model, provider: ctx.config.models?.executor?.provider }

  while (true) {
    if (ctx.signal.aborted || ctx.isCancelled()) {
      state.status = "cancelled"
      break
    }
    await ctx.gate.wait()
    if (ctx.signal.aborted || ctx.isCancelled()) {
      state.status = "cancelled"
      break
    }

    const reason = ctx.budget.exhaustedReason()
    if (reason) {
      ctx.cb.emit("run.progress", { runId: ctx.runId, step: 0, done: false, message: `${ctx.executorId}: ${reason}` })
      break
    }

    let output: ModelOutput
    try {
      output = await callModel(ctx.model, buildMessages(ctx, history), modelOpt, ctx.signal, ctx)
    } catch (err) {
      if (ctx.signal.aborted) {
        state.status = "cancelled"
        break
      }
      state.error = (err as Error).message
      state.status = "error"
      break
    }

    state.tokenUsed += output.tokens
    const costDelta = estimateCost(output.tokens, ctx.config.models?.executor?.model, ctx.costModel)
    state.costUsd += costDelta
    ctx.budget.addCost(costDelta)

    if (output.type === "tool_call" && output.call) {
      const call = output.call
      const args = call.arguments ?? {}
      const idempotencyKey = typeof args["idempotencyKey"] === "string" ? String(args["idempotencyKey"]) : undefined
      const frame: ToolCallFrame = { call: { ...call, idempotencyKey }, result: { ok: false, error: "pending" } }

      const policy = approvalDecision(ctx.config.mode, ctx.skill, call)
      if (policy.required) {
        const approved = await ctx.approvals.requestApproval(call, policy.reason, policy.risk)
        if (!approved) {
          frame.result = { ok: false, error: "denied by user", idempotencyKey }
          history.push(frame)
          continue
        }
      }

      if (isBudgetTool(call.name)) {
        const check = ctx.budget.tryConsumeRequest()
        if (!check.ok) break
        state.requestsUsed = ctx.budget.requestsUsed
      }

      ctx.cb.emit("tool.call", { runId: ctx.runId, toolCall: call })
      await ctx.semaphore.acquire()
      let result: Awaited<ReturnType<ToolBridge["request"]>>
      try {
        result = await ctx.bridge.request(call.name, args, { signal: ctx.signal })
      } catch (err) {
        result = { ok: false, error: (err as Error).message }
      } finally {
        ctx.semaphore.release()
      }
      frame.result = { ok: result.ok, result: result.result, error: result.error, idempotencyKey }
      history.push(frame)
      if (history.length > window) history.splice(0, history.length - window)
      continue
    }

    const parsed = parseConclusion(output.text, ctx.item.endpoint)
    if (parsed.finding) state.findings.push(parsed.finding)
    break
  }

  state.requestsUsed = ctx.budget.requestsUsed
  state.costUsd = ctx.budget.costUsd
  if (state.status === "running") state.status = "completed"
  return state
}
