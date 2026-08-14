export type RpcId = number | string

export interface RpcRequest {
  jsonrpc: "2.0"
  id: RpcId
  method: string
  params?: Record<string, unknown>
}

export interface RpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: Record<string, unknown>
}

export interface RpcError {
  code: number
  message: string
  data?: unknown
}

export interface RpcResponse {
  jsonrpc: "2.0"
  id: RpcId | null
  result?: unknown
  error?: RpcError
}

export interface Handshake {
  projectId: string
  nonce: string
  token: string
}

export type MessageSource = "proxy" | "siteMap" | "agent" | "websocket"

export interface MessageRef {
  projectId: string
  source: MessageSource
  id: number | string
  digest?: string
}

export interface HttpMessage {
  startLine: string
  headers: Record<string, string>
  body?: string
  bodyOffset?: number
  bodyTruncated?: boolean
}

export type RedactedHttpMessage = HttpMessage

export interface ToolCall {
  name: string
  arguments: Record<string, unknown>
  idempotencyKey?: string
}

export interface ToolResult {
  ok: boolean
  result?: unknown
  error?: string
  idempotencyKey?: string
}

export type Severity = "info" | "low" | "medium" | "high" | "critical"
export type Confidence = "tentative" | "medium" | "high" | "certain"
export type FindingStatus = "candidate" | "validated" | "confirmed" | "rejected" | "duplicate"

export interface Evidence {
  kind: "request-response" | "collaborator" | "diff" | "timing" | "screenshot-note"
  refs: MessageRef[]
  redactedPayload?: string
  timestamp: number
}

export interface Finding {
  id: string
  title: string
  vulnClass: string
  severity: Severity
  confidence: Confidence
  status: FindingStatus
  chain?: string[]
  skill?: string
  runId?: string
  program?: string
  assets?: string[]
  evidence: Evidence[]
}

export interface SkillManifest {
  id: string
  version: string
  name: string
  description?: string
  triggers?: string[]
  tools?: { allow?: string[]; deny?: string[] }
  limits?: {
    requests?: number
    durationSeconds?: number
    concurrency?: number
    maxCostUsd?: number
  }
  modelPreference?: string
  authRequired?: "anon" | "accountA" | "accountB" | "dual"
  approvalPolicy?: "auto" | "approval"
  scripts?: Array<{ name: string; wasmHash?: string }>
  mcp?: string[]
  workflow?: string
  prompt?: string
}

export interface ModelInfo {
  id: string
  provider: string
  displayName?: string
  supportsToolCall?: boolean
  supportsVision?: boolean
  contextWindow?: number
}

export interface ProviderStatus {
  provider: string
  connected: boolean
  method: "api-key" | "oauth" | "none"
  user?: string
  expiresAt?: number
  modelCount?: number
}

export interface RunStatus {
  runId: string
  status: "running" | "paused" | "completed" | "cancelled" | "error"
  plan?: string[]
  currentStep?: number
  totalSteps?: number
  requestsUsed: number
  requestCap: number
  costUsd: number
  costCapUsd: number
  tokenUsed: number
  startedAt: number
  executors?: Array<{ id: string; endpoint: string; status: string; requestsUsed: number }>
}

export interface ApprovalRequest {
  id: string
  runId: string
  reason: string
  toolCall: ToolCall
  target?: string
  risk: "low" | "medium" | "high" | "critical"
  expiresAt?: number
}
