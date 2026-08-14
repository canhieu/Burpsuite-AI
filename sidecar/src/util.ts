import { randomUUID } from "node:crypto"
import { isSensitiveHeader, maskValue } from "./redact.js"

export function newId(prefix = ""): string {
  return prefix + randomUUID().replace(/-/g, "").slice(0, 20)
}

export function newSecret(len = 24): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  let out = ""
  for (const b of bytes) out += chars[b % chars.length]
  return out
}

export function now(): number {
  return Date.now()
}

const SECRET_VALUE_RE =
  /([&;,\s]?)([a-zA-Z0-9._~-]{1,64}(?:token|api[_-]?key|password|secret|auth)[a-zA-Z0-9._~-]*)(=)([^&\s;,]+)/gi
const BEARER_RE = /\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/=-]{16,}/g
const JSON_SECRET_RE = /("(?:[^"]*(?:token|api[_-]?key|password|secret|auth)[^"]*)"\s*:\s*")([^"]+)(")/gi

export function redactString(input: string): string {
  if (!input) return input
  return input
    .replace(BEARER_RE, "{{redacted:Authorization}}")
    .replace(JSON_SECRET_RE, `$1{{redacted:$2}}$3`)
    .replace(SECRET_VALUE_RE, (m, pre, name, eq, val) => `${pre}${name}${eq}{{redacted:${name}}}`)
}

export interface Logger {
  level: "debug" | "info" | "warn" | "error"
  debug(msg: string, meta?: unknown): void
  info(msg: string, meta?: unknown): void
  warn(msg: string, meta?: unknown): void
  error(msg: string, meta?: unknown): void
  child(scope: string): Logger
}

const LEVEL_ORDER: Record<Logger["level"], number> = { debug: 10, info: 20, warn: 30, error: 40 }

export function createLogger(level: Logger["level"] = "info", scope = "sidecar"): Logger {
  const write = (lvl: Logger["level"], msg: string, meta?: unknown) => {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return
    const ts = new Date().toISOString()
    const metaStr = meta === undefined ? "" : " " + JSON.stringify(redactJson(meta))
    const line = `${ts} ${lvl.toUpperCase().padEnd(5)} [${scope}] ${redactString(msg)}${metaStr}`
    if (lvl === "error") console.error(line)
    else if (lvl === "warn") console.warn(line)
    else console.log(line)
  }
  return {
    level,
    debug: (m, meta) => write("debug", m, meta),
    info: (m, meta) => write("info", m, meta),
    warn: (m, meta) => write("warn", m, meta),
    error: (m, meta) => write("error", m, meta),
    child: (s) => createLogger(level, `${scope}:${s}`),
  }
}

function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redactJson(v))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveHeader(k) || /token|api[_-]?key|password|secret|key/i.test(k)) {
        out[k] = maskValue(String(v), k)
      } else if (typeof v === "string") {
        out[k] = redactString(v)
      } else {
        out[k] = redactJson(v)
      }
    }
    return out
  }
  return value
}
