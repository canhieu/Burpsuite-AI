import type { WebSocket } from "ws"
import type { SidecarConfig } from "../config.js"
import type { Store } from "../store.js"
import type { ProviderRegistry } from "../providers.js"

export interface Services {
  config: SidecarConfig
  store: Store
  registry: ProviderRegistry
  startTime: number
  sidecarVersion: string
  log: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void
  getProviderStatuses: () => Promise<import("../types.js").ProviderStatus[]>
  /** Rebuild provider adapters from the current in-memory config (for config.set). */
  rebuildRegistry?: () => void | Promise<void>
}

export interface RpcContext {
  ws: WebSocket
  authed: boolean
  projectId?: string
  sendNotification(method: string, params: Record<string, unknown>): void
  sendAgentEvent(type: string, data: unknown): void
}

export type Handler = (params: Record<string, unknown>, ctx: RpcContext, services: Services) => unknown | Promise<unknown>

export type HandlerGroup = Record<string, Handler>

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message)
    this.name = "RpcError"
  }
}
