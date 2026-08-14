import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http"

export interface ProviderServerOptions {
  port?: number
  host?: string
}

export interface ProviderServerHandle {
  server: Server
  port: number
  url: string
  close: () => Promise<void>
}

const DEFAULT_HOST = process.env.HOST ?? "127.0.0.1"
const MODELS = [
  { id: "gpt-mock-1", object: "model", owned_by: "fixtures" },
  { id: "gpt-mock-fast", object: "model", owned_by: "fixtures" },
  { id: "mock-vision", object: "model", owned_by: "fixtures" },
]

interface ChatMessage {
  role?: string
  content?: string | Array<{ type?: string; text?: string }>
}

function lastUserText(messages: ChatMessage[] | undefined): string {
  if (!Array.isArray(messages)) return ""
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue
    if (msg.role === "user") {
      if (typeof msg.content === "string") return msg.content
      if (Array.isArray(msg.content)) {
        return msg.content
          .map((p) => (p && typeof p.text === "string" ? p.text : ""))
          .join(" ")
      }
    }
  }
  return ""
}

function wantsTool(messages: ChatMessage[] | undefined): boolean {
  return lastUserText(messages).toLowerCase().includes("tool")
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

function sendSse(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
}

function sseLine(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function toolCallChunk(model: string): unknown {
  return {
    id: "chatcmpl-mock-1",
    object: "chat.completion.chunk",
    model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_mock_search",
              type: "function",
              function: {
                name: "search_http_history",
                arguments: "{\"q\":\"*\"}",
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  }
}

function chatTextChunk(model: string, text: string): unknown {
  return {
    id: "chatcmpl-mock-1",
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  }
}

function toolCallFull(model: string): unknown {
  return {
    id: "chatcmpl-mock-1",
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_mock_search",
              type: "function",
              function: {
                name: "search_http_history",
                arguments: "{\"q\":\"*\"}",
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }
}

function chatTextFull(model: string, text: string): unknown {
  return {
    id: "chatcmpl-mock-1",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }
}

function handleChatCompletions(req: IncomingMessage, res: ServerResponse, body: unknown, fail: string): void {
  const params = body as Record<string, unknown>
  const model = String(params.model ?? "gpt-mock-1")
  const stream = params.stream === true
  const messages = params.messages as ChatMessage[] | undefined

  if (fail === "500") {
    sendJson(res, 500, { error: { message: "mock provider unavailable", type: "server_error" } })
    return
  }
  if (fail === "403") {
    sendJson(res, 403, { error: { message: "mock provider unauthorized", type: "auth_error" } })
    return
  }
  if (fail === "stream_error" && stream) {
    sendSse(res)
    sseLine(res, chatTextChunk(model, "Hello"))
    sseLine(res, chatTextChunk(model, " from the mock"))
    sseLine(res, { error: { message: "mid-stream failure", type: "stream_error" } })
    res.end()
    return
  }

  const tool = wantsTool(messages)
  if (stream) {
    sendSse(res)
    if (tool) {
      sseLine(res, toolCallChunk(model))
    } else {
      const text = `Hello from mock model ${model}`
      const step = 7
      for (let i = 0; i < text.length; i += step) {
        sseLine(res, chatTextChunk(model, text.slice(i, i + step)))
      }
    }
    sseLine(res, { id: "chatcmpl-mock-1", object: "chat.completion.chunk", model, choices: [] })
    res.write("data: [DONE]\n\n")
    res.end()
    return
  }

  if (tool) {
    sendJson(res, 200, toolCallFull(model))
    return
  }
  sendJson(res, 200, chatTextFull(model, `Hello from mock model ${model}`))
}

function responsesInput(body: unknown): ChatMessage[] {
  const params = body as Record<string, unknown>
  if (Array.isArray(params.messages)) return params.messages as ChatMessage[]
  const input = params.input
  if (Array.isArray(input)) return input as ChatMessage[]
  if (typeof input === "string") return [{ role: "user", content: input }]
  return []
}

function handleResponses(req: IncomingMessage, res: ServerResponse, body: unknown, fail: string): void {
  const params = body as Record<string, unknown>
  const model = String(params.model ?? "gpt-mock-1")
  const stream = params.stream === true
  const messages = responsesInput(body)

  if (fail === "500") {
    sendJson(res, 500, { error: { message: "mock provider unavailable" } })
    return
  }
  if (fail === "403") {
    sendJson(res, 403, { error: { message: "mock provider unauthorized" } })
    return
  }
  if (fail === "stream_error" && stream) {
    sendSse(res)
    sseLine(res, { type: "response.output_text.delta", delta: "Hello" })
    sseLine(res, { type: "error", error: { message: "mid-stream failure" } })
    res.end()
    return
  }

  const tool = wantsTool(messages)
  if (stream) {
    sendSse(res)
    sseLine(res, { type: "response.created", response: { id: "resp_mock_1", model } })
    if (tool) {
      sseLine(res, {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          id: "call_mock_search",
          name: "search_http_history",
          arguments: "{\"q\":\"*\"}",
        },
      })
    } else {
      const text = `Hello from mock model ${model}`
      const step = 7
      for (let i = 0; i < text.length; i += step) {
        sseLine(res, { type: "response.output_text.delta", delta: text.slice(i, i + step) })
      }
    }
    sseLine(res, { type: "response.completed", response: { id: "resp_mock_1", model } })
    res.end()
    return
  }

  if (tool) {
    sendJson(res, 200, {
      id: "resp_mock_1",
      object: "response",
      model,
      output: [
        {
          type: "function_call",
          id: "call_mock_search",
          name: "search_http_history",
          arguments: "{\"q\":\"*\"}",
          status: "completed",
        },
      ],
    })
    return
  }
  sendJson(res, 200, {
    id: "resp_mock_1",
    object: "response",
    model,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `Hello from mock model ${model}` }],
      },
    ],
  })
}

export async function startProviderServer(opts: ProviderServerOptions = {}): Promise<ProviderServerHandle> {
  const port = opts.port ?? 0
  const host = opts.host ?? DEFAULT_HOST

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
      const fail = process.env.PROVIDER_FAIL ?? ""

      if (req.method === "GET" && url.pathname === "/v1/models") {
        sendJson(res, 200, { object: "list", data: MODELS })
        return
      }
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true })
        return
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" })
        return
      }
      const bodyRaw = await readBody(req)
      let body: unknown
      try {
        body = bodyRaw.length > 0 ? JSON.parse(bodyRaw) : {}
      } catch {
        sendJson(res, 400, { error: "invalid json" })
        return
      }

      if (url.pathname === "/v1/chat/completions") {
        handleChatCompletions(req, res, body, fail)
        return
      }
      if (url.pathname === "/v1/responses") {
        handleResponses(req, res, body, fail)
        return
      }
      sendJson(res, 404, { error: "unknown endpoint" })
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
