import type { ApprovalRequest, Finding, MessageRef, SkillManifest, ToolCall, ToolResult } from "../types.js"
import type { PauseGate } from "./pause-gate.js"

export type RunMode = "manual" | "smart" | "autonomous"
export type RunPhase = "planning" | "running" | "paused" | "completed" | "cancelled" | "error"
export type ExecutorStatus = "idle" | "running" | "paused" | "completed" | "cancelled" | "error"

export interface RunBudget {
  requests?: number
  durationSeconds?: number
  concurrency?: number
  maxCostUsd?: number
}

export interface RunConfig {
  task: string
  skill?: string
  mode: RunMode
  scope?: string[]
  budget?: RunBudget
  models?: { planner?: string; executor?: string; reviewer?: string }
  executors?: number
  seedRefs?: MessageRef[]
}

export interface PlanItem {
  endpoint: string
  skill: string
  hypothesis: string
}

export interface ExecutorState {
  id: string
  endpoint: string
  status: ExecutorStatus
  requestsUsed: number
}

export interface FindingDraft {
  title: string
  vulnClass: string
  severity: string
  confidence: string
  detail?: string
  endpoint?: string
}

export interface ToolCallFrame {
  call: ToolCall
  result: ToolResult
}

export interface Run {
  runId: string
  config: RunConfig
  phase: RunPhase
  plan: PlanItem[]
  executors: ExecutorState[]
  findings: FindingDraft[]
  startedAt: number
  updatedAt: number
  requestsUsed: number
  requestCap: number
  costUsd: number
  costCapUsd: number
  tokenUsed: number
  cancelled: boolean
  error?: string
  abort: AbortController
  gate: PauseGate
}

export type { ApprovalRequest, Finding, MessageRef, SkillManifest, ToolCall, ToolResult }
