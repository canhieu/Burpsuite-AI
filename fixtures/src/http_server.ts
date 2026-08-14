import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http"

export type Scenario = "normal" | "idor" | "sqli" | "xss"

export interface HttpServerOptions {
  scenario?: Scenario
  port?: number
  host?: string
}

export interface HttpServerHandle {
  server: Server
  port: number
  url: string
  close: () => Promise<void>
}

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  params: string[],
) => void | Promise<void>

interface Route {
  method: string
  pattern: RegExp
  scenarios: string[]
  handler: Handler
}

const DEFAULT_HOST = process.env.HOST ?? "127.0.0.1"
const SQL_ERROR_TEXT = "SQLite syntax error near \"%s\": syntax error"

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json" })
  res.end(payload)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function rateLimiter(maxPerSecond: number): { allow: (now: number) => boolean } {
  const hits: number[] = []
  return {
    allow(now: number): boolean {
      while (hits.length > 0 && now - hits[0] > 1000) hits.shift()
      if (hits.length >= maxPerSecond) return false
      hits.push(now)
      return true
    },
  }
}

export async function startHttpServer(opts: HttpServerOptions = {}): Promise<HttpServerHandle> {
  const scenario = opts.scenario ?? "normal"
  const port = opts.port ?? 0
  const host = opts.host ?? DEFAULT_HOST

  const slowLimiter = rateLimiter(10)

  const routes: Route[] = [
    {
      method: "GET",
      pattern: /^\/$/,
      scenarios: ["all"],
      handler: (_req, res) => {
        res.writeHead(200, { "content-type": "text/html" })
        res.end(
          "<!doctype html><html><head><title>Burp Agent Fixtures</title></head>" +
            '<body><h1>Target App Mock</h1><a href="/health">health</a></body></html>',
        )
      },
    },
    {
      method: "GET",
      pattern: /^\/health$/,
      scenarios: ["all"],
      handler: (_req, res) => {
        sendJson(res, 200, { ok: true })
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/orders\/([^/]+)$/,
      scenarios: ["normal"],
      handler: async (req, res, _url, params) => {
        if (!req.headers.authorization) {
          sendJson(res, 401, { error: "missing authorization" })
          return
        }
        const id = params[0]
        const body = await readBody(req)
        let parsed: unknown = null
        try {
          parsed = body.length > 0 ? JSON.parse(body) : null
        } catch {
          parsed = null
        }
        sendJson(res, 200, { id, echo: parsed ?? body })
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/users\/(\d+)$/,
      scenarios: ["idor", "normal"],
      handler: (req, res, url, params) => {
        const id = Number(params[0])
        const delay = Math.min(
          Number(url.searchParams.get("delay") ?? 0) ||
            Number(req.headers["x-delay"] ?? 0) ||
            0,
          10000,
        )
        const owner = id <= 100 ? "accountA" : "accountB"
        const respond = () => sendJson(res, 200, { id, owner })
        if (delay > 0) {
          setTimeout(respond, delay)
        } else {
          respond()
        }
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/search$/,
      scenarios: ["sqli", "normal"],
      handler: (req, res, url) => {
        const q = url.searchParams.get("q") ?? ""
        const isSql = q.includes("'") || q.toUpperCase().includes('" OR "')
        if (isSql) {
          const text = SQL_ERROR_TEXT.replace("%s", q.slice(0, 40))
          res.writeHead(500, { "content-type": "text/plain" })
          res.end(text)
          return
        }
        sendJson(res, 200, {
          q,
          results: [
            { id: 1, title: `result a for ${q}` },
            { id: 2, title: `result b for ${q}` },
          ],
        })
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/redirect$/,
      scenarios: ["normal"],
      handler: (_req, res) => {
        res.writeHead(302, { location: "/health" })
        res.end()
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/reflect$/,
      scenarios: ["xss", "normal"],
      handler: (_req, res, url) => {
        const x = url.searchParams.get("x") ?? ""
        res.writeHead(200, { "content-type": "text/html" })
        res.end(`<html><body><div class="out">${x}</div></body></html>`)
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/echoheaders$/,
      scenarios: ["normal"],
      handler: (req, res) => {
        sendJson(res, 200, { headers: req.headers })
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/big$/,
      scenarios: ["normal"],
      handler: (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" })
        res.end("a".repeat(200 * 1024))
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/slow$/,
      scenarios: ["normal"],
      handler: (_req, res) => {
        if (!slowLimiter.allow(Date.now())) {
          res.writeHead(429, { "retry-after": "1", "content-type": "application/json" })
          res.end(JSON.stringify({ error: "rate limited", retryAfter: 1 }))
          return
        }
        sendJson(res, 200, { ok: true, at: Date.now() })
      },
    },
  ]

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
      const method = req.method ?? "GET"
      for (const route of routes) {
        if (route.method !== method) continue
        const m = route.pattern.exec(url.pathname)
        if (!m) continue
        const enabled =
          scenario === "normal" || route.scenarios.includes("all") || route.scenarios.includes(scenario)
        if (!enabled) {
          sendJson(res, 404, { error: `route disabled in scenario ${scenario}` })
          return
        }
        await route.handler(req, res, url, m.slice(1))
        return
      }
      sendJson(res, 404, { error: "not found" })
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "internal error", detail: String(err) }))
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, resolve)
  })

  const address = server.address()
  const actualPort = typeof address === "object" && address !== null ? address.port : port

  return {
    server,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close: () =>
      new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve()
          return
        }
        server.close(() => resolve())
      }),
  }
}
