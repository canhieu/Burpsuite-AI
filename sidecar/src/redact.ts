import type { HttpMessage } from "./types.js"

const WHOLE_HEADERS = new Set(["authorization", "cookie", "set-cookie", "proxy-authorization"])
const SECRET_RE = /token|api[_-]?key|password|secret/i

export function isSensitiveHeader(name: string): boolean {
  const l = name.toLowerCase()
  return WHOLE_HEADERS.has(l) || SECRET_RE.test(l)
}

export function maskValue(value: string, header: string): string {
  void value
  return `{{redacted:${header}}}`
}

export function maskCookies(value: string, header: string): string {
  return value
    .split(/;\s*/)
    .map((pair) => {
      const eq = pair.indexOf("=")
      if (eq === -1) return pair
      const name = pair.slice(0, eq).trim()
      return `${name}={{redacted:${header}}}`
    })
    .join("; ")
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    const l = k.toLowerCase()
    if (l === "cookie" || l === "set-cookie") out[k] = maskCookies(v, l)
    else if (WHOLE_HEADERS.has(l)) out[k] = maskValue(v, l)
    else if (SECRET_RE.test(l)) out[k] = maskValue(v, k)
    else out[k] = v
  }
  return out
}

const BODY_SECRET_JSON_RE = /("(?:[^"]*(?:token|api[_-]?key|password|secret|authorization)[^"]*)"\s*:\s*")([^"]+)(")/gi
const BODY_SECRET_PAIR_RE = /([&;\s])([a-zA-Z0-9._~-]*(?:token|api[_-]?key|password|secret|authorization)[a-zA-Z0-9._~-]*)(=)([^&\s;,]+)/gi
const BEARER_RE = /\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/=-]{16,}/g

export function redactBody(body?: string): string | undefined {
  if (body === undefined || body === "") return body
  let out = body
  if (body.trimStart().startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(body)
      const redacted = redactJson(parsed)
      return JSON.stringify(redacted)
    } catch {
      /* fall through to regex redaction */
    }
  }
  out = out.replace(BODY_SECRET_JSON_RE, (m, p1, p2, p3) => `${p1}{{redacted:${p2}}}${p3}`)
  out = out.replace(BODY_SECRET_PAIR_RE, (m, pre, name, eq) => `${pre}${name}${eq}{{redacted:${name}}}`)
  out = out.replace(BEARER_RE, "{{redacted:Authorization}}")
  return out
}

function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redactJson(v))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_RE.test(k)) out[k] = `{{redacted:${k}}}`
      else if (typeof v === "string") {
        const sv = redactStringField(v)
        out[k] = sv
      } else out[k] = redactJson(v)
    }
    return out
  }
  return value
}

function redactStringField(value: string): string {
  return value.replace(BEARER_RE, "{{redacted:Authorization}}")
}

export function redactMessage(msg: HttpMessage): HttpMessage {
  const headers = redactHeaders(msg.headers ?? {})
  const body = redactBody(msg.body)
  return { ...msg, headers, body }
}

export function redactRequest(msg: HttpMessage): HttpMessage {
  return redactMessage(msg)
}

export function redactResponse(msg: HttpMessage): HttpMessage {
  return redactMessage(msg)
}

export function shouldRedact(params: Record<string, unknown> | undefined, defaultRedact = true): boolean {
  if (params === undefined) return defaultRedact
  const r = params["redacted"]
  if (r === false) return false
  if (r === true) return true
  return defaultRedact
}
