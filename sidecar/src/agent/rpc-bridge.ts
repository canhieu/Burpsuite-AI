import { RpcError, type Handler, type Services } from "../handlers/types.js"
import type { RpcServer, TimeoutError } from "../rpc.js"
import type { ToolResult } from "../types.js"

export interface BridgeResult extends ToolResult {
  code?: number
  policyBlocked?: boolean
}

export interface ToolBridge {
  request(method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<BridgeResult>
}

const LOCAL_PREFIXES = [
  "payload.",
  "crypto.",
  "finding.",
  "evidence.",
  "report.",
  "notify.",
  "settings.",
  "models.",
  "auth.",
  "oob.",
  "vault.",
  "sandbox.",
]

export function isLocalMethod(method: string): boolean {
  return LOCAL_PREFIXES.some((p) => method.startsWith(p))
}

export class ExtensionToolBridge implements ToolBridge {
  constructor(
    private handlers: Map<string, Handler>,
    private services: Services,
    private rpc: RpcServer,
    private defaultTimeoutMs = 60_000,
  ) {}

  async request(method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<BridgeResult> {
    if (isLocalMethod(method)) {
      return this.localCall(method, params)
    }
    return this.extensionCall(method, params, opts?.timeoutMs ?? this.defaultTimeoutMs, opts?.signal)
  }

  private async localCall(method: string, params: Record<string, unknown>): Promise<BridgeResult> {
    const handler = this.handlers.get(method)
    if (!handler) return { ok: false, error: `method not found: ${method}`, code: -32601 }
    try {
      const result = await handler(params, this.rpc.getClientContext(), this.services)
      return { ok: true, result }
    } catch (err) {
      const code = err instanceof RpcError ? err.code : 500
      return { ok: false, error: (err as Error).message, code }
    }
  }

  private async extensionCall(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<BridgeResult> {
    try {
      const result = await this.rpc.request(method, params, { timeoutMs, signal })
      return { ok: true, result }
    } catch (err) {
      if (err instanceof RpcError) {
        return { ok: false, error: err.message, code: err.code, policyBlocked: err.code === 403 }
      }
      if (err instanceof Error && err.name === "TimeoutError") {
        return { ok: false, error: `tool call timed out: ${method}`, code: 504 }
      }
      return { ok: false, error: (err as Error).message }
    }
  }
}

export type { TimeoutError }
