import type { HandlerGroup } from "./types.js"

export function mcpHandlers(): HandlerGroup {
  return {
    "mcp.servers.list": () => ({ servers: [] }),
    "mcp.server.add": () => ({ error: "no mcp servers configured" }),
    "mcp.server.remove": () => ({ error: "no mcp servers configured" }),
    "mcp.call": () => ({ error: "no mcp servers configured" }),
  }
}

export function sandboxHandlers(): HandlerGroup {
  return {
    "sandbox.run": () => ({ ok: false, error: "sandbox not available" }),
  }
}
