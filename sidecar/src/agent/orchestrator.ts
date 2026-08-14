import type { ChatMessage, ProviderEvent } from "../providers.js"
import type { ApprovalRequest, Finding, SkillManifest } from "../types.js"
import type { RunStatus } from "../types.js"
import type { Store } from "../store.js"
import { newId, now, redactString } from "../util.js"
import { BudgetTracker, Semaphore } from "./budget.js"
import type { BudgetWarning } from "./budget.js"
import { PauseGate } from "./pause-gate.js"
import type { ApprovalGate, ModelClient } from "./executor.js"
import { estimateTokens, runExecutor } from "./executor.js"
import type { ToolBridge } from "./rpc-bridge.js"
import type { FindingDraft, PlanItem, Run, RunBudget, RunConfig } from "./types.js"
import type { ExecutorStatus } from "./types.js"

const MAX_PLAN = 20
const BUDGET_OVERHEAD = 0.2
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

export interface AgentEngineDeps {
  emit(method: string, params: Record<string, unknown>): void
  bridge: ToolBridge
  models: { planner?: ModelClient; executor?: ModelClient }
  getSkill?: (name: string) => SkillManifest | undefined
  store?: Store
  log?: (level: "debug" | "info" | "warn" | "error", msg: string) => void
  costModel?: Record<string, { inputPerMtok?: number; outputPerMtok?: number }>
  approvalTimeoutMs?: number
}

interface PendingApproval {
  runId: string
  resolve: (approved: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

export class AgentEngine {
  private runs = new Map<string, Run>()
  private promises = new Map<string, Promise<void>>()
  private approvals = new Map<string, PendingApproval>()
  private approvalRequests = new Map<string, ApprovalRequest>()

  constructor(private deps: AgentEngineDeps) {}

  async start(config: RunConfig): Promise<string> {
    const runId = newId("run_")
    const run: Run = {
      runId,
      config,
      phase: "planning",
      plan: [],
      executors: [],
      findings: [],
      startedAt: now(),
      updatedAt: now(),
      requestsUsed: 0,
      requestCap: config.budget?.requests ?? 0,
      costUsd: 0,
      costCapUsd: config.budget?.maxCostUsd ?? 0,
      tokenUsed: 0,
      cancelled: false,
      abort: new AbortController(),
      gate: new PauseGate(),
    }
    this.runs.set(runId, run)
    this.persist(run)
    const p = this.runOrchestrator(run)
    this.promises.set(runId, p)
    return runId
  }

  private async runOrchestrator(run: Run): Promise<void> {
    try {
      this.emit("run.progress", { runId: run.runId, step: 0, done: false, message: "planning" })
      const plan = await this.buildPlan(run)
      if (run.cancelled || run.abort.signal.aborted) {
        run.phase = "cancelled"
        this.persist(run)
        return
      }
      run.plan = plan
      run.phase = "running"
      this.persist(run)
      this.emit("run.progress", { runId: run.runId, step: 1, done: false, message: `plan ready: ${plan.length} item(s)` })

      const executorCount = Math.max(1, Math.min(run.config.executors ?? 3, 20))
      const semaphore = new Semaphore(run.config.budget?.concurrency ?? 4)
      const assignments = this.assignPlan(plan, executorCount)
      run.executors = assignments.map((items, i) => ({
        id: `ex_${i + 1}`,
        endpoint: items.map((x) => x.endpoint).filter(Boolean).join(";") || "(all)",
        status: "running" as ExecutorStatus,
        requestsUsed: 0,
      }))
      this.persist(run)

      const budgets = this.splitBudgets(run, executorCount)
      const skill = run.config.skill ? this.deps.getSkill?.(run.config.skill) : undefined
      const model = this.deps.models.executor
      if (!model) throw new Error("no executor model available")
      const approvalGate = this.makeApprovalGate(run)
      const cb = { emit: (method: string, params: Record<string, unknown>) => this.emit(method, params) }
      const costModel = this.deps.costModel ?? {}

      await Promise.allSettled(
        assignments.map(async (items, i) => {
          const budget = budgets[i]
          const executor = run.executors[i]
          for (const item of items) {
            if (run.cancelled || run.abort.signal.aborted) break
            const res = await runExecutor({
              runId: run.runId,
              executorId: executor.id,
              item,
              skill,
              config: run.config,
              model,
              bridge: this.deps.bridge,
              budget,
              semaphore,
              approvals: approvalGate,
              cb,
              signal: run.abort.signal,
              gate: run.gate,
              isCancelled: () => run.cancelled || run.abort.signal.aborted,
              historyWindow: 8,
              costModel,
            })
            executor.status = res.status
            executor.requestsUsed = res.requestsUsed
            run.requestsUsed += res.requestsUsed
            run.tokenUsed += res.tokenUsed
            run.costUsd += res.costUsd
            for (const fd of res.findings) this.commitFinding(run, fd)
            this.persist(run)
          }
        }),
      )

      run.phase = run.cancelled || run.abort.signal.aborted ? "cancelled" : "completed"
      run.updatedAt = now()
      this.persist(run)
      this.emit("run.progress", { runId: run.runId, step: Math.max(run.plan.length + 1, 2), done: true, message: run.phase })
    } catch (err) {
      run.phase = "error"
      run.error = err instanceof Error ? err.message : String(err)
      run.updatedAt = now()
      this.persist(run)
      this.emit("run.progress", { runId: run.runId, step: 0, done: true, message: `error: ${run.error}` })
    }
  }

  private async buildPlan(run: Run): Promise<PlanItem[]> {
    const planner = this.deps.models.planner
    if (!planner) return this.fallbackPlan(run.config)
    const skill = run.config.skill ? this.deps.getSkill?.(run.config.skill) : undefined
    const system = [
      "You are a security testing planner. Given a task, optional scope, optional skill, and seed references, produce a JSON array of plan items.",
      'Each item is an object: {"endpoint": "<url/endpoint string, may be empty>", "skill": "<skill name or empty>", "hypothesis": "<what to test and why>"}.',
      "Split the task into focused endpoint-level subtasks. Return ONLY the JSON array, no prose.",
    ].join(" ")
    const user = JSON.stringify({
      task: run.config.task,
      skill: skill?.name ?? run.config.skill,
      skillPrompt: skill?.prompt,
      scope: run.config.scope ?? [],
      seedRefs: (run.config.seedRefs ?? []).map((r) => ({ projectId: r.projectId, source: r.source, id: r.id })),
    })
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ]
    let text: string
    try {
      const out = await collectModelText(planner, messages, { model: run.config.models?.planner }, run.abort.signal)
      text = out.text
    } catch (err) {
      if (run.abort.signal.aborted) throw err
      this.log("warn", `planner failed, falling back to single-item plan: ${(err as Error).message}`)
      return this.fallbackPlan(run.config)
    }
    const items = parsePlan(text)
    if (!items.length) return this.fallbackPlan(run.config)
    return items.slice(0, MAX_PLAN)
  }

  private fallbackPlan(config: RunConfig): PlanItem[] {
    return [{ endpoint: "", skill: config.skill ?? "", hypothesis: config.task }]
  }

  private assignPlan(plan: PlanItem[], count: number): PlanItem[][] {
    const out: PlanItem[][] = Array.from({ length: count }, () => [])
    plan.forEach((item, i) => out[i % count].push(item))
    return out
  }

  private splitBudgets(run: Run, count: number): BudgetTracker[] {
    const b = run.config.budget ?? {}
    const perCount = Math.max(1, count)
    const capRequests = b.requests !== undefined ? Math.max(1, Math.floor((b.requests * (1 - BUDGET_OVERHEAD)) / perCount)) : undefined
    const capCostUsd = b.maxCostUsd !== undefined ? Math.max(0.01, (b.maxCostUsd * (1 - BUDGET_OVERHEAD)) / perCount) : undefined
    const deadline = b.durationSeconds !== undefined ? run.startedAt + b.durationSeconds * 1000 * (1 - BUDGET_OVERHEAD) : undefined
    const onWarning = (w: BudgetWarning) => this.emit("budget.warning", { runId: run.runId, metric: w.metric, value: w.value, cap: w.cap })
    const trackers: BudgetTracker[] = []
    for (let i = 0; i < count; i++) trackers.push(new BudgetTracker(capRequests, deadline, capCostUsd, onWarning))
    return trackers
  }

  private commitFinding(run: Run, fd: FindingDraft): void {
    if (run.findings.some((x) => x.title === fd.title && x.vulnClass === fd.vulnClass)) return
    run.findings.push(fd)
    const finding: Finding = {
      id: newId("fnd_"),
      title: fd.title,
      vulnClass: fd.vulnClass,
      severity: fd.severity as Finding["severity"],
      confidence: fd.confidence as Finding["confidence"],
      status: "candidate",
      runId: run.runId,
      skill: run.config.skill,
      assets: fd.endpoint ? [fd.endpoint] : undefined,
      evidence: [],
    }
    if (this.deps.store) {
      try {
        this.deps.store.createFinding(finding)
      } catch {
        /* duplicate id, ignore */
      }
    }
    this.emit("finding.updated", { finding })
  }

  private makeApprovalGate(run: Run): ApprovalGate {
    return {
      requestApproval: (call, reason, risk) =>
        new Promise<boolean>((resolve) => {
          const requestId = newId("apr_")
          const timeoutMs = this.deps.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
          const request: ApprovalRequest = {
            id: requestId,
            runId: run.runId,
            reason,
            toolCall: call,
            target: call.name,
            risk: risk as ApprovalRequest["risk"],
            expiresAt: now() + timeoutMs,
          }
          this.approvalRequests.set(requestId, request)
          this.emit("approval.requested", { runId: run.runId, request })
          const timer = setTimeout(() => {
            this.approvals.delete(requestId)
            this.approvalRequests.delete(requestId)
            resolve(false)
          }, timeoutMs)
          this.approvals.set(requestId, { runId: run.runId, resolve, timer })
        }),
    }
  }

  approve(requestId: string, approved: boolean): { ok: boolean; approved?: boolean; error?: string } {
    const entry = this.approvals.get(requestId)
    if (!entry) return { ok: false, error: "no pending approval" }
    clearTimeout(entry.timer)
    this.approvals.delete(requestId)
    this.approvalRequests.delete(requestId)
    entry.resolve(approved)
    return { ok: true, approved }
  }

  pause(runId?: string): void {
    for (const run of this.active(runId)) {
      if (run.phase === "planning") {
        run.phase = "paused"
      } else if (run.phase !== "running") {
        continue
      } else {
        run.phase = "paused"
      }
      run.gate.pause()
      this.persist(run)
      this.emit("run.progress", { runId: run.runId, step: 0, done: false, message: "paused" })
    }
  }

  resume(runId?: string): void {
    for (const run of this.active(runId)) {
      if (run.phase !== "paused") continue
      run.phase = "running"
      run.gate.resume()
      this.persist(run)
      this.emit("run.progress", { runId: run.runId, step: 0, done: false, message: "resumed" })
    }
  }

  cancel(runId?: string): void {
    for (const run of this.active(runId)) {
      if (run.phase === "completed" || run.phase === "cancelled" || run.phase === "error") continue
      run.cancelled = true
      run.phase = "cancelled"
      run.gate.release()
      this.resolveAllApprovals(false)
      this.persist(run)
      this.emit("run.progress", { runId: run.runId, step: 0, done: true, message: "cancelled" })
    }
  }

  kill(): void {
    for (const run of this.runs.values()) {
      if (run.phase === "completed" || run.phase === "cancelled" || run.phase === "error") continue
      run.cancelled = true
      run.phase = "cancelled"
      run.gate.release()
      run.abort.abort()
      this.resolveAllApprovals(false)
      this.persist(run)
      this.emit("run.progress", { runId: run.runId, step: 0, done: true, message: "cancelled" })
    }
  }

  status(runId: string): RunStatus | undefined {
    const run = this.runs.get(runId)
    if (run) return this.toRunStatus(run)
    const rec = this.deps.store?.getRun(runId)
    if (!rec) return undefined
    const d = rec.data
    return {
      runId,
      status: (d["status"] as RunStatus["status"]) ?? "running",
      plan: Array.isArray(d["plan"]) ? (d["plan"] as string[]) : undefined,
      requestsUsed: typeof d["requestsUsed"] === "number" ? d["requestsUsed"] : 0,
      requestCap: typeof d["requestCap"] === "number" ? d["requestCap"] : 0,
      costUsd: typeof d["costUsd"] === "number" ? d["costUsd"] : 0,
      costCapUsd: typeof d["costCapUsd"] === "number" ? d["costCapUsd"] : 0,
      tokenUsed: typeof d["tokenUsed"] === "number" ? d["tokenUsed"] : 0,
      startedAt: typeof d["startedAt"] === "number" ? d["startedAt"] : rec.startedAt,
      executors: Array.isArray(d["executors"]) ? (d["executors"] as RunStatus["executors"]) : undefined,
    }
  }

  findings(runId: string): FindingDraft[] {
    return this.runs.get(runId)?.findings ?? []
  }

  async waitFor(runId: string): Promise<RunStatus> {
    const p = this.promises.get(runId)
    if (p) await p
    const st = this.status(runId)
    if (st) return st
    throw new Error(`run not found: ${runId}`)
  }

  private toRunStatus(run: Run): RunStatus {
    return {
      runId: run.runId,
      status: run.phase === "planning" ? "running" : run.phase,
      plan: run.plan.map((p) => `${p.endpoint}${p.skill ? ` [${p.skill}]` : ""}`),
      currentStep: 0,
      totalSteps: run.plan.length,
      requestsUsed: run.requestsUsed,
      requestCap: run.requestCap,
      costUsd: run.costUsd,
      costCapUsd: run.costCapUsd,
      tokenUsed: run.tokenUsed,
      startedAt: run.startedAt,
      executors: run.executors.map((e) => ({ id: e.id, endpoint: e.endpoint, status: e.status, requestsUsed: e.requestsUsed })),
    }
  }

  private active(runId?: string): Run[] {
    if (runId) {
      const run = this.runs.get(runId)
      return run ? [run] : []
    }
    return [...this.runs.values()]
  }

  private resolveAllApprovals(approved: boolean): void {
    for (const [id, entry] of this.approvals) {
      clearTimeout(entry.timer)
      this.approvals.delete(id)
      this.approvalRequests.delete(id)
      entry.resolve(approved)
    }
  }

  private persist(run: Run): void {
    if (!this.deps.store) return
    this.deps.store.saveRun(run.runId, {
      status: run.phase,
      plan: run.plan.map((p) => `${redactString(p.endpoint)}${p.skill ? ` [${p.skill}]` : ""}`),
      requestsUsed: run.requestsUsed,
      requestCap: run.requestCap,
      costUsd: run.costUsd,
      costCapUsd: run.costCapUsd,
      tokenUsed: run.tokenUsed,
      startedAt: run.startedAt,
      executors: run.executors,
      error: run.error,
    })
  }

  private emit(method: string, params: Record<string, unknown>): void {
    try {
      this.deps.emit(method, params)
    } catch {
      /* event sinks must not crash the run */
    }
  }

  private log(level: "debug" | "info" | "warn" | "error", msg: string): void {
    this.deps.log?.(level, msg)
  }
}

export function parsePlan(text: string): PlanItem[] {
  for (const block of extractJsonBlocks(text)) {
    try {
      const parsed = JSON.parse(block)
      if (!Array.isArray(parsed)) continue
      const items: PlanItem[] = []
      for (const el of parsed) {
        if (!el || typeof el !== "object") continue
        const e = el as Record<string, unknown>
        const endpoint = typeof e["endpoint"] === "string" ? e["endpoint"] : typeof e["url"] === "string" ? e["url"] : ""
        const skill = typeof e["skill"] === "string" ? e["skill"] : ""
        const hypothesis = typeof e["hypothesis"] === "string" ? e["hypothesis"] : typeof e["task"] === "string" ? e["task"] : ""
        if (!endpoint && !hypothesis) continue
        items.push({ endpoint, skill, hypothesis })
      }
      if (items.length) return items.slice(0, MAX_PLAN)
    } catch {
      /* keep scanning */
    }
  }
  return []
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

async function collectModelText(
  model: ModelClient,
  messages: ChatMessage[],
  opts: { model?: string },
  signal: AbortSignal,
): Promise<{ text: string; tokens: number }> {
  let text = ""
  let tokens = 0
  const onUsage = (usage: unknown) => {
    tokens += estimateTokens(usage)
  }
  const iter = model.stream(messages, { model: opts.model, signal, onUsage })
  for await (const ev of iter) {
    if (ev.type === "text") text += String(ev.data)
    else if (ev.type === "error") throw new Error(`planner error: ${String(ev.data)}`)
  }
  return { text, tokens }
}

export type { ProviderEvent }
