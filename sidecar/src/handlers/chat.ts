import type { ChatMessage } from "../providers.js"
import { streamFromRegistry } from "../providers.js"
import type { HandlerGroup } from "./types.js"

export function chatHandlers(): HandlerGroup {
  return {
    "agent.chat": async (params, ctx, services) => {
      const raw = params["messages"]
      const messages = Array.isArray(raw)
        ? (raw as ChatMessage[]).filter((m) => m && typeof m.role === "string" && typeof m.content === "string")
        : []
      if (messages.length === 0) throw new Error("agent.chat requires messages")
      const provider = typeof params["provider"] === "string" ? params["provider"] : undefined
      const model = typeof params["model"] === "string" ? params["model"] : undefined
      const stream = params["stream"] !== false
      const skill = typeof params["skill"] === "string" ? params["skill"] : undefined
      const skillContext = skill ? `[skill:${skill}]` : undefined
      const streamOpts = {
        maxTokens: typeof params["maxTokens"] === "number" ? params["maxTokens"] : undefined,
        reasoningEffort: typeof params["reasoning"] === "string" ? params["reasoning"] : undefined,
      }
      const finalMessages = skillContext ? [{ role: "system" as const, content: skillContext }, ...messages] : messages

      const iter = await streamFromRegistry(services.registry, finalMessages, { provider, model, stream: streamOpts })
      if (!stream) {
        let text = ""
        for await (const ev of iter) {
          if (ev.type === "text") text += String(ev.data)
        }
        services.store.putMessage(
          { projectId: ctx.projectId ?? "agent", source: "agent", id: crypto.randomUUID() },
          text.slice(0, 1000),
          { provider, model },
        )
        return { done: true, text }
      }
      for await (const ev of iter) {
        if (ev.type === "text") {
          ctx.sendAgentEvent("text", ev.data)
        } else if (ev.type === "tool_call") {
          ctx.sendAgentEvent("tool_call", ev.data)
        } else if (ev.type === "error") {
          ctx.sendAgentEvent("error", ev.data)
        }
      }
      ctx.sendAgentEvent("done", {})
      return { done: true }
    },
  }
}
