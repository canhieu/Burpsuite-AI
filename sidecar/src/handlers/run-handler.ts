import type { RpcServer } from "../rpc.js"
import { RpcError, type Handler, type HandlerGroup, type Services } from "./types.js"
import type { MessageRef, SkillManifest } from "../types.js"
import { AgentEngine } from "../agent/orchestrator.js"
import { ExtensionToolBridge, type ToolBridge } from "../agent/rpc-bridge.js"
import { defaultModelClient } from "../agent/models.js"
import type { ModelClient } from "../agent/executor.js"
import type { RunBudget, RunConfig, RunMode } from "../agent/types.js"

export interface RunHandlersDeps {
  services: Services
  handlers: Map<string, Handler>
  bridge?: ToolBridge
  models?: { planner?: ModelClient; executor?: ModelClient }
  getSkill?: (name: string) => SkillManifest | undefined
  approvalTimeoutMs?: number
  engine?: AgentEngine
}

const MODES = new Set(["manual", "smart", "autonomous"])

function sanitizeBudget(raw: unknown): RunBudget | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const o = raw as Record<string, unknown>
  const out: RunBudget = {}
  if (typeof o["requests"] === "number") out.requests = Math.max(1, Math.floor(o["requests"]))
  if (typeof o["durationSeconds"] === "number") out.durationSeconds = Math.max(1, Math.floor(o["durationSeconds"]))
  if (typeof o["concurrency"] === "number") out.concurrency = Math.max(1, Math.floor(o["concurrency"]))
  if (typeof o["maxCostUsd"] === "number") out.maxCostUsd = Math.max(0, o["maxCostUsd"])
  return Object.keys(out).length ? out : undefined
}

function sanitizeModels(raw: unknown): RunConfig["models"] {
  if (!raw || typeof raw !== "object") return undefined
  const o = raw as Record<string, unknown>
  const out: NonNullable<RunConfig["models"]> = {}
  for (const role of ["planner", "executor", "reviewer"] as const) {
    if (typeof o[role] === "string" && o[role]) out[role] = o[role] as string
  }
  return Object.keys(out).length ? out : undefined
}

export function registerRunHandlers(rpc: RpcServer, deps: RunHandlersDeps): { engine: AgentEngine; group: HandlerGroup } {
  const bridge = deps.bridge ?? new ExtensionToolBridge(deps.handlers, deps.services, rpc)
  const registryModels = { planner: defaultModelClient(deps.services.registry), executor: defaultModelClient(deps.services.registry) }
  const engine =
    deps.engine ??
    new AgentEngine({
      emit: (method, params) => rpc.emit(method, params),
      bridge,
      models: deps.models ?? registryModels,
      getSkill: deps.getSkill,
      store: deps.services.store,
      log: (level, msg) => deps.services.log(level, msg),
      approvalTimeoutMs: deps.approvalTimeoutMs,
    })

  const group: HandlerGroup = {
    "agent.run.start": async (params) => {
      const task = typeof params["task"] === "string" && params["task"].length > 0 ? params["task"] : undefined
      if (!task) throw new RpcError(-32600, "agent.run.start requires a task")
      const rawMode = typeof params["mode"] === "string" ? params["mode"] : undefined
      const mode: RunMode = rawMode && MODES.has(rawMode) ? (rawMode as RunMode) : "smart"
      const skill = typeof params["skill"] === "string" && params["skill"] ? params["skill"] : undefined
      const scope = Array.isArray(params["scope"]) ? (params["scope"] as unknown[]).filter((s): s is string => typeof s === "string") : undefined
      const budget = sanitizeBudget(params["budget"])
      const models = sanitizeModels(params["models"])
      const executors = typeof params["executors"] === "number" ? params["executors"] : undefined
      const seedRefs = Array.isArray(params["seedRefs"])
        ? (params["seedRefs"] as unknown[]).filter((r): r is MessageRef => !!r && typeof r === "object")
        : undefined
      const runId = await engine.start({ task, skill, mode, scope, budget, models, executors, seedRefs })
      return { runId }
    },
    "agent.run.pause": (params) => {
      engine.pause(typeof params["runId"] === "string" ? params["runId"] : undefined)
      return { ok: true }
    },
    "agent.run.resume": (params) => {
      engine.resume(typeof params["runId"] === "string" ? params["runId"] : undefined)
      return { ok: true }
    },
    "agent.run.cancel": (params) => {
      engine.cancel(typeof params["runId"] === "string" ? params["runId"] : undefined)
      return { ok: true }
    },
    "agent.run.kill": () => {
      engine.kill()
      return { ok: true }
    },
    "agent.run.status": (params) => {
      const runId = typeof params["runId"] === "string" ? params["runId"] : undefined
      if (!runId) throw new RpcError(-32600, "agent.run.status requires runId")
      const st = engine.status(runId)
      if (!st) throw new RpcError(404, `run not found: ${runId}`)
      return st
    },
    "agent.approve": (params) => {
      const requestId = typeof params["requestId"] === "string" ? params["requestId"] : undefined
      if (!requestId) throw new RpcError(-32600, "agent.approve requires requestId")
      const approved = params["approved"] !== false
      return engine.approve(requestId, approved)
    },
  }

  return { engine, group }
}
