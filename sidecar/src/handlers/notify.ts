import type { HandlerGroup } from "./types.js"

export function notifyHandlers(): HandlerGroup {
  return {
    "notify.send": async (params, _c, services) => {
      const channel = String(params["channel"] ?? "webhook")
      const event = String(params["event"] ?? "")
      const payload = params["payload"] ?? {}
      const text = formatEvent(event, payload)

      try {
        if (channel === "telegram") return await sendTelegram(services.config, text)
        if (channel === "webhook") return await sendWebhook(services.config, event, payload)
        return { sent: false, error: `unknown channel: ${channel}` }
      } catch (err) {
        services.log("warn", `notify.send failed: ${(err as Error).message}`)
        return { sent: false, error: "notification failed" }
      }
    },
  }
}

function formatEvent(event: string, payload: unknown): string {
  const summary =
    payload && typeof payload === "object"
      ? Object.entries(payload as Record<string, unknown>)
          .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 200) : JSON.stringify(v).slice(0, 200)}`)
          .join(" | ")
      : String(payload)
  return `[burp-agent] ${event}: ${summary}`
}

async function sendTelegram(
  config: import("../config.js").SidecarConfig,
  text: string,
): Promise<{ sent: boolean; error?: string }> {
  const tg = config.notifications.telegram
  const botToken = tg?.botTokenEnv ? process.env[tg.botTokenEnv] : undefined
  const chatId = tg?.chatIdEnv ? process.env[tg.chatIdEnv] : undefined
  if (!botToken || !chatId) return { sent: false, error: "telegram not configured" }
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
  if (!res.ok) throw new Error(`telegram http ${res.status}`)
  return { sent: true }
}

async function sendWebhook(
  config: import("../config.js").SidecarConfig,
  event: string,
  payload: unknown,
): Promise<{ sent: boolean; error?: string }> {
  const wh = config.notifications.webhook
  const url = wh?.urlEnv ? process.env[wh.urlEnv] : undefined
  if (!url) return { sent: false, error: "webhook not configured" }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, payload }),
  })
  if (!res.ok) throw new Error(`webhook http ${res.status}`)
  return { sent: true }
}
