import type { ModelInfo, ProviderStatus } from "./types.js"
import type { SidecarConfig } from "./config.js"
import { providerApiKey } from "./config.js"

export type { ProviderStatus }

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  toolCallId?: string
  name?: string
}

export type ProviderEventType = "text" | "tool_call" | "tool_result" | "done" | "error"

export interface ProviderEvent {
  type: ProviderEventType
  data: unknown
}

export interface StreamOptions {
  maxTokens?: number
  temperature?: number
  tools?: unknown[]
  signal?: AbortSignal
  onUsage?: (usage: unknown) => void
}

export interface ProviderAdapter {
  readonly provider: string
  readonly baseUrl: string
  hasKey: boolean
  stream(messages: ChatMessage[], model: string, opts?: StreamOptions): AsyncIterable<ProviderEvent>
  listModels(): Promise<ModelInfo[]>
  healthCheck(): Promise<boolean>
}

export interface ProviderRegistry {
  get(provider: string): ProviderAdapter | undefined
  all(): ProviderAdapter[]
  listModels(): Promise<ModelInfo[]>
  resolveModel(alias: string): ModelInfo | undefined
  roleModel(role: string): ModelInfo | undefined
  statuses(): Promise<ProviderStatus[]>
}

export async function createProviderRegistry(
  config: SidecarConfig,
  opts?: { resolveToken?: (provider: string) => Promise<string | undefined> },
): Promise<ProviderRegistry> {
  const resolveToken = opts?.resolveToken
  const adapters = new Map<string, ProviderAdapter>()
  const providers: Record<string, ProviderAdapter> = {
    openai: new OpenAIAdapter(config, resolveToken),
    anthropic: new AnthropicAdapter(config, resolveToken),
    deepseek: new DeepSeekAdapter(config),
    ollama: new OllamaAdapter(config),
  }
  for (const [name, adapter] of Object.entries(providers)) {
    if (config.providers[name]?.enabled) adapters.set(name, adapter)
  }

  const registry: ProviderRegistry = {
    get: (name) => adapters.get(name),
    all: () => [...adapters.values()],
    async listModels() {
      const all: ModelInfo[] = []
      for (const a of adapters.values()) {
        try {
          all.push(...(await a.listModels()))
        } catch {
          /* provider unreachable: fall through */
        }
      }
      return all
    },
    resolveModel(alias) {
      const norm = alias.toLowerCase().trim()
      const role = config.models.roles[norm as keyof typeof config.models.roles]
      if (role) {
        const a = adapters.get(role.provider)
        if (a) return { id: role.model, provider: a.provider }
        return { id: role.model, provider: role.provider }
      }
      const [maybeProvider, ...rest] = norm.split(/[/:]/)
      if (rest.length > 0) {
        return { id: rest.join("/"), provider: maybeProvider }
      }
      if (norm === "latest-codex") {
        const openaiAdapter = adapters.get("openai")
        return { id: "gpt-5.1-codex", provider: "openai", displayName: openaiAdapter ? undefined : undefined, contextWindow: 400000 }
      }
      const byProvider = adapters.get(maybeProvider)
      if (byProvider) {
        const roleMatch = Object.entries(config.models.roles).find(([, r]) => r.provider === maybeProvider)
        const model = roleMatch ? roleMatch[1].model : DEFAULT_MODELS[maybeProvider]?.[0]
        if (model) return { id: model, provider: maybeProvider }
      }
      for (const a of adapters.values()) {
        if (norm.startsWith(a.provider + "/") || norm.includes(a.provider)) {
          return { id: norm.split(/[/:]/).slice(1).join("/"), provider: a.provider }
        }
      }
      return undefined
    },
    roleModel(role) {
      const r = config.models.roles[role as keyof typeof config.models.roles]
      if (!r) return undefined
      return { id: r.model, provider: r.provider }
    },
    async statuses() {
      const out: ProviderStatus[] = []
      for (const a of adapters.values()) {
        const connected = await a.healthCheck()
        const method = a.hasKey ? "api-key" : "none"
        let modelCount: number | undefined
        if (connected) {
          try {
            modelCount = (await a.listModels()).length
          } catch {
            modelCount = undefined
          }
        }
        out.push({ provider: a.provider, connected, method, modelCount })
      }
      return out
    },
  }
  return registry
}

const DEFAULT_MODELS: Record<string, string[]> = {
  openai: ["gpt-5.1-codex", "gpt-5.1-codex-mini", "latest-codex"],
  anthropic: ["claude-sonnet-4-5", "claude-3-7-sonnet-latest", "claude-3-5-haiku-latest"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  ollama: ["llama3.1", "qwen2.5", "mistral"],
}

function modelInfo(id: string, provider: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return { id, provider, displayName: id, contextWindow: 128000, ...extra }
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  return res.json()
}

async function* streamSse(body: ReadableStream<Uint8Array> | null, signal?: AbortSignal): AsyncGenerator<string> {
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      if (signal?.aborted) throw new Error("aborted")
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim()
          if (payload) yield payload
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

async function* openAiCompatibleStream(
  baseUrl: string,
  apiKey: string | undefined,
  messages: ChatMessage[],
  model: string,
  opts?: StreamOptions,
): AsyncGenerator<ProviderEvent> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`

  const body: Record<string, unknown> = {
    model,
    messages: messages.map((m) => {
      const out: Record<string, unknown> = { role: m.role, content: m.content }
      if (m.role === "tool") {
        out["tool_call_id"] = m.toolCallId
        out["content"] = JSON.stringify(m.content)
      }
      return out
    }),
    stream: true,
  }
  if (opts?.maxTokens) body["max_tokens"] = opts.maxTokens
  if (opts?.temperature !== undefined) body["temperature"] = opts.temperature
  if (opts?.tools) body["tools"] = opts.tools

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: opts?.signal,
  })
  if (!res.ok) {
    let detail = ""
    try {
      detail = JSON.stringify(await res.json())
    } catch {
      detail = await res.text()
    }
    throw new Error(`provider error ${res.status}: ${detail.slice(0, 500)}`)
  }

  const toolAcc = new Map<number, { id: string; name: string; args: string; emitted: boolean }>()
  let pendingToolId = ""

  for await (const raw of streamSse(res.body, opts?.signal)) {
    if (raw === "[DONE]") {
      for (const t of [...toolAcc.values()]) {
        if (t.id && !t.emitted) {
          t.emitted = true
          yield { type: "tool_call", data: { id: t.id, name: t.name, arguments: t.args } }
        }
      }
      yield { type: "done", data: { finishReason: "stop" } }
      return
    }
    let chunk: Record<string, unknown>
    try {
      chunk = JSON.parse(raw)
    } catch {
      continue
    }
    if (chunk["usage"] && opts?.onUsage) opts.onUsage(chunk["usage"])
    const choices = chunk["choices"] as Array<Record<string, unknown>> | undefined
    if (!choices || !choices.length) continue
    const delta = (choices[0]["delta"] as Record<string, unknown>) ?? {}
    const finish = choices[0]["finish_reason"]
    const text = delta["content"]
    if (typeof text === "string" && text.length) yield { type: "text", data: text }
    const toolCalls = delta["tool_calls"] as Array<Record<string, unknown>> | undefined
    if (toolCalls) {
      for (const tc of toolCalls) {
        const idx = Number(tc["index"] ?? 0)
        const acc = toolAcc.get(idx) ?? { id: "", name: "", args: "", emitted: false }
        if (tc["id"] && !acc.id) acc.id = String(tc["id"])
        if (tc["id"]) pendingToolId = String(tc["id"])
        const fn = tc["function"] as Record<string, unknown> | undefined
        if (fn) {
          if (fn["name"]) acc.name += String(fn["name"])
          if (fn["arguments"]) acc.args += String(fn["arguments"])
        }
        toolAcc.set(idx, acc)
      }
    }
    if (finish && toolAcc.size > 0) {
      for (const t of [...toolAcc.values()]) {
        if (t.id && !t.emitted) {
          t.emitted = true
          yield { type: "tool_call", data: { id: t.id, name: t.name, arguments: t.args } }
        }
      }
    }
  }
  for (const t of [...toolAcc.values()]) {
    if (t.id && !t.emitted) {
      t.emitted = true
      yield { type: "tool_call", data: { id: t.id, name: t.name, arguments: t.args } }
    }
  }
  void pendingToolId
  yield { type: "done", data: { finishReason: "stop" } }
}

class OpenAIAdapter implements ProviderAdapter {
  readonly provider = "openai"
  readonly baseUrl: string
  readonly hasKey: boolean
  private config: SidecarConfig
  private resolveToken: ((p: string) => Promise<string | undefined>) | undefined

  constructor(config: SidecarConfig, resolveToken?: (p: string) => Promise<string | undefined>) {
    const c = config.providers["openai"]
    this.config = config
    this.baseUrl = c?.baseUrl ?? "https://api.openai.com/v1"
    this.hasKey = !!providerApiKey(config, "openai")
    this.resolveToken = resolveToken
  }

  private get key(): string | undefined {
    return providerApiKey(this.config, "openai")
  }

  /** True when we are using an OAuth (ChatGPT/Codex subscription) session, not an API key. */
  private async isOAuthSession(): Promise<boolean> {
    if (this.key) return false
    if (!this.resolveToken) return false
    const tok = await this.resolveToken("openai")
    return !!tok
  }

  private async authHeader(): Promise<Record<string, string>> {
    const key = this.key
    if (key) return { Authorization: `Bearer ${key}` }
    if (this.resolveToken) {
      const tok = await this.resolveToken("openai")
      if (tok) return { Authorization: `Bearer ${tok}` }
    }
    return {}
  }

  async *stream(messages: ChatMessage[], model: string, opts?: StreamOptions): AsyncGenerator<ProviderEvent> {
    if (await this.isOAuthSession()) {
      const headers = await this.authHeader()
      const token = headers["Authorization"]?.slice(7) ?? ""
      const codexModel = codexModelFor(model, this.config)
      yield* openAiResponsesStream(this.baseUrl, token, messages, codexModel, opts)
      return
    }
    const headers = await this.authHeader()
    yield* openAiCompatibleStream(this.baseUrl, headers["Authorization"]?.slice(7), messages, model, opts)
  }

  async listModels(): Promise<ModelInfo[]> {
    if (await this.isOAuthSession()) {
      // ChatGPT-subscription tokens cannot list models via /v1/models (403).
      const extras = this.config.models.openai?.extra ?? []
      const codexModels = CODEX_MODELS
      const def = this.config.models.openai?.default && codexModels.includes(this.config.models.openai!.default!)
        ? this.config.models.openai!.default!
        : CODEX_MODELS[0]
      const ids = [def, ...extras.filter((m) => m !== def), ...codexModels.filter((m) => m !== def && !extras.includes(m))]
      return ids.map((m) => modelInfo(m, "openai", { contextWindow: 400000 }))
    }
    try {
      const headers = await this.authHeader()
      const res = await fetch(`${this.baseUrl}/models`, { headers })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { data?: Array<{ id: string }> }
      return (json.data ?? []).map((m) => modelInfo(m.id, "openai"))
    } catch {
      const extra = this.config.models.openai?.extra ?? []
      const def = this.config.models.openai?.default ?? DEFAULT_MODELS.openai![0]
      return [def, ...extra, ...DEFAULT_MODELS.openai!.filter((m) => m !== def)].map((m) => modelInfo(m, "openai"))
    }
  }

  async healthCheck(): Promise<boolean> {
    if (await this.isOAuthSession()) {
      // /v1/models 403s for subscription tokens; a session presence + token is our health signal.
      const headers = await this.authHeader()
      return !!headers["Authorization"]
    }
    try {
      const headers = await this.authHeader()
      const res = await fetch(`${this.baseUrl}/models`, {
        headers,
        signal: AbortSignal.timeout(5000),
      })
      return res.ok
    } catch {
      return false
    }
  }
}

/** Codex models usable with ChatGPT-subscription OAuth tokens via the Responses API. */
const CODEX_MODELS = ["gpt-5.1-codex", "gpt-5-codex", "gpt-5.1-codex-mini", "o3", "latest-codex"]

function codexModelFor(requested: string, config: SidecarConfig): string {
  const def = config.models.openai?.default ?? ""
  const cands = [requested, def, "gpt-5.1-codex"]
  for (const c of cands) {
    if (c && (CODEX_MODELS.includes(c) || c === "latest-codex")) return c
  }
  return "gpt-5.1-codex"
}

/**
 * Stream against OpenAI's Responses API (used by Codex CLI with ChatGPT-subscription
 * OAuth tokens). Handles response.output_text.delta + tool calls.
 */
async function* openAiResponsesStream(
  baseUrl: string,
  token: string,
  messages: ChatMessage[],
  model: string,
  opts?: StreamOptions,
): AsyncGenerator<ProviderEvent> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  }
  // Map ChatMessage[] to Responses API input items.
  const input: unknown[] = messages.map((m) => {
    if (m.role === "system") return { role: "system", content: [{ type: "input_text", text: m.content }] }
    if (m.role === "assistant") return { role: "assistant", content: [{ type: "output_text", text: m.content }] }
    if (m.role === "tool") {
      return { type: "function_call_output", call_id: m.toolCallId ?? "call_0", output: m.content }
    }
    return { role: "user", content: [{ type: "input_text", text: m.content }] }
  })

  const body: Record<string, unknown> = {
    model,
    input,
    stream: true,
  }
  if (opts?.maxTokens) body["max_output_tokens"] = opts.maxTokens
  if (opts?.tools && Array.isArray(opts.tools) && opts.tools.length > 0) {
    body["tools"] = opts.tools
  }

  let res: Response
  try {
    res = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: opts?.signal,
    })
  } catch (e) {
    yield { type: "error", data: { message: `openai responses: ${(e as Error).message}` } }
    return
  }
  if (!res.ok) {
    let detail = ""
    try {
      detail = JSON.stringify(await res.json())
    } catch {
      detail = await res.text()
    }
    yield { type: "error", data: { message: `provider error ${res.status}: ${detail.slice(0, 500)}` } }
    return
  }

  const toolNames = new Map<string, string>()
  const toolArgs = new Map<string, string>()
  const emitted = new Set<string>()

  for await (const raw of streamSse(res.body, opts?.signal)) {
    let evt: Record<string, unknown>
    try {
      evt = JSON.parse(raw)
    } catch {
      continue
    }
    const type = evt["type"] as string
    if (type === "response.output_text.delta") {
      const delta = evt["delta"]
      if (typeof delta === "string" && delta) yield { type: "text", data: delta }
    } else if (type === "response.output_item.added") {
      const item = evt["item"] as Record<string, unknown> | undefined
      if (item && item["type"] === "function_call") {
        const id = String(item["id"] ?? "")
        const name = String(item["name"] ?? "")
        if (id && name) toolNames.set(id, name)
        const args = String(item["arguments"] ?? "")
        if (id && args) toolArgs.set(id, (toolArgs.get(id) ?? "") + args)
      }
    } else if (type === "response.output_item.done") {
      const item = evt["item"] as Record<string, unknown> | undefined
      if (item && item["type"] === "function_call") {
        const id = String(item["id"] ?? "")
        const name = String(item["name"] ?? "")
        const args = String(item["arguments"] ?? toolArgs.get(id) ?? "")
        if (id && name) toolNames.set(id, name)
        if (id && !emitted.has(id)) {
          emitted.add(id)
          let parsedArgs: unknown = args
          try {
            parsedArgs = JSON.parse(args)
          } catch {
            /* keep string */
          }
          yield { type: "tool_call", data: { id, name, arguments: parsedArgs } }
        }
      }
    } else if (type === "response.function_call_arguments.delta") {
      const id = String(evt["item_id"] ?? "")
      const delta = evt["delta"]
      if (typeof delta === "string" && id) toolArgs.set(id, (toolArgs.get(id) ?? "") + delta)
    } else if (type === "response.function_call_arguments.done") {
      const id = String(evt["item_id"] ?? "")
      const args = String(evt["arguments"] ?? toolArgs.get(id) ?? "")
      if (id && !emitted.has(id)) {
        emitted.add(id)
        let parsedArgs: unknown = args
        try {
          parsedArgs = JSON.parse(args)
        } catch {
          /* keep string */
        }
        yield { type: "tool_call", data: { id, name: toolNames.get(id) ?? "unknown", arguments: parsedArgs } }
      }
    } else if (type === "response.completed") {
      yield { type: "done", data: { finishReason: "complete" } }
      return
    } else if (type === "response.failed") {
      const resp = evt["response"] as Record<string, unknown> | undefined
      const err = resp?.["error"] as Record<string, unknown> | undefined
      yield { type: "error", data: { message: String(err?.["message"] ?? "responses request failed") } }
      return
    }
  }
  // Flush any pending tool calls not finished with a .done event.
  for (const [id, name] of toolNames) {
    if (!emitted.has(id)) {
      emitted.add(id)
      yield { type: "tool_call", data: { id, name, arguments: (() => { try { return JSON.parse(toolArgs.get(id) ?? "") } catch { return toolArgs.get(id) ?? "" } })() } }
    }
  }
  yield { type: "done", data: { finishReason: "stop" } }
}

class DeepSeekAdapter implements ProviderAdapter {
  readonly provider = "deepseek"
  readonly baseUrl: string
  readonly hasKey: boolean

  constructor(private config: SidecarConfig) {
    const c = config.providers["deepseek"]
    this.baseUrl = c?.baseUrl ?? "https://api.deepseek.com/v1"
    this.hasKey = !!providerApiKey(config, "deepseek")
  }

  private get key(): string | undefined {
    return providerApiKey(this.config, "deepseek")
  }

  async *stream(messages: ChatMessage[], model: string, opts?: StreamOptions): AsyncGenerator<ProviderEvent> {
    yield* openAiCompatibleStream(this.baseUrl, this.key, messages, model, opts)
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, { headers: { Authorization: `Bearer ${this.key ?? ""}` } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { data?: Array<{ id: string }> }
      return (json.data ?? []).map((m) => modelInfo(m.id, "deepseek"))
    } catch {
      const extra = this.config.models.deepseek?.extra ?? []
      const def = this.config.models.deepseek?.default ?? DEFAULT_MODELS.deepseek![0]
      return [def, ...extra, ...DEFAULT_MODELS.deepseek!.filter((m) => m !== def)].map((m) => modelInfo(m, "deepseek"))
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.key ?? ""}` },
        signal: AbortSignal.timeout(5000),
      })
      return res.ok
    } catch {
      return false
    }
  }
}

class OllamaAdapter implements ProviderAdapter {
  readonly provider = "ollama"
  readonly baseUrl: string
  readonly hasKey = false

  constructor(config: SidecarConfig) {
    this.baseUrl = config.providers["ollama"]?.baseUrl ?? "http://127.0.0.1:11434/v1"
  }

  async *stream(messages: ChatMessage[], model: string, opts?: StreamOptions): AsyncGenerator<ProviderEvent> {
    yield* openAiCompatibleStream(this.baseUrl, undefined, messages, model, opts)
  }

  async listModels(): Promise<ModelInfo[]> {
    const tryUrls = [`${this.baseUrl}/models`, this.baseUrl.replace(/\/v1$/, "") + "/api/tags"]
    for (const url of tryUrls) {
      try {
        const json = (await fetchJson(url)) as { models?: Array<{ name?: string; model?: string }>; data?: Array<{ id: string }> }
        const ids = (json.models ?? []).map((m) => m.name ?? m.model).filter(Boolean) as string[]
        const ids2 = (json.data ?? []).map((m) => m.id)
        const all = [...ids, ...ids2]
        if (all.length) return all.map((id) => modelInfo(id, "ollama", { contextWindow: 131072 }))
      } catch {
        /* try next */
      }
    }
    const extra: string[] = []
    return ["llama3.1", "qwen2.5", "mistral", ...extra].map((m) => modelInfo(m, "ollama", { contextWindow: 131072 }))
  }

  async healthCheck(): Promise<boolean> {
    const urls = [`${this.baseUrl}/models`, this.baseUrl.replace(/\/v1$/, "") + "/api/tags"]
    for (const url of urls) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
        if (res.ok) return true
      } catch {
        /* try next */
      }
    }
    return false
  }
}

class AnthropicAdapter implements ProviderAdapter {
  readonly provider = "anthropic"
  readonly baseUrl: string
  readonly hasKey: boolean
  private config: SidecarConfig
  private resolveToken: ((p: string) => Promise<string | undefined>) | undefined

  constructor(config: SidecarConfig, resolveToken?: (p: string) => Promise<string | undefined>) {
    const c = config.providers["anthropic"]
    this.config = config
    this.baseUrl = c?.baseUrl ?? "https://api.anthropic.com/v1"
    this.hasKey = !!providerApiKey(config, "anthropic")
    this.resolveToken = resolveToken
  }

  private get key(): string | undefined {
    return providerApiKey(this.config, "anthropic")
  }

  private async headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = {
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    }
    const key = this.key
    if (key) {
      h["x-api-key"] = key
    } else if (this.resolveToken) {
      const tok = await this.resolveToken("anthropic")
      if (tok) h["Authorization"] = `Bearer ${tok}`
    }
    return h
  }

  async *stream(messages: ChatMessage[], model: string, opts?: StreamOptions): AsyncGenerator<ProviderEvent> {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n")
    const apiMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => {
        if (m.role === "tool") {
          return { role: "user" as const, content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] }
        }
        if (m.role === "assistant") return { role: "assistant" as const, content: m.content }
        return { role: "user" as const, content: m.content }
      })

    const body: Record<string, unknown> = { model, max_tokens: opts?.maxTokens ?? 4096, messages: apiMessages, stream: true }
    if (system) body["system"] = system
    if (opts?.temperature !== undefined) body["temperature"] = opts.temperature

    const res = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify(body),
      signal: opts?.signal,
    })
    if (!res.ok) {
      let detail = ""
      try {
        detail = JSON.stringify(await res.json())
      } catch {
        detail = await res.text()
      }
      throw new Error(`anthropic error ${res.status}: ${detail.slice(0, 500)}`)
    }

    const toolAcc = new Map<string, { id: string; name: string; args: string }>()
    let currentTool: string | null = null

    for await (const raw of streamSse(res.body, opts?.signal)) {
      let evt: Record<string, unknown>
      try {
        evt = JSON.parse(raw)
      } catch {
        continue
      }
      const type = evt["type"]
      if (type === "content_block_start") {
        const cb = evt["content_block"] as Record<string, unknown>
        if (cb?.["type"] === "tool_use") {
          const id = String(cb["id"] ?? "")
          toolAcc.set(id, { id, name: String(cb["name"] ?? ""), args: "" })
          currentTool = id
        }
      } else if (type === "content_block_delta") {
        const delta = evt["delta"] as Record<string, unknown>
        if (delta?.["type"] === "text_delta" && typeof delta["text"] === "string") {
          yield { type: "text", data: delta["text"] }
        } else if (delta?.["type"] === "input_json_delta" && currentTool) {
          const acc = toolAcc.get(currentTool)
          if (acc) acc.args += String(delta["partial_json"] ?? "")
        }
      } else if (type === "content_block_stop" && currentTool) {
        const acc = toolAcc.get(currentTool)
        if (acc) yield { type: "tool_call", data: { id: acc.id, name: acc.name, arguments: acc.args } }
        currentTool = null
      } else if (type === "message_delta") {
        const usage = evt["usage"]
        if (usage && opts?.onUsage) opts.onUsage(usage)
      } else if (type === "message_stop") {
        yield { type: "done", data: { finishReason: "stop" } }
        return
      }
    }
    yield { type: "done", data: { finishReason: "stop" } }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, { headers: await this.headers() })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { data?: Array<{ id: string }> }
      return (json.data ?? []).map((m) => modelInfo(m.id, "anthropic"))
    } catch {
      const extra = this.config.models.anthropic?.extra ?? []
      const def = this.config.models.anthropic?.default ?? DEFAULT_MODELS.anthropic![0]
      return [def, ...extra, ...DEFAULT_MODELS.anthropic!.filter((m) => m !== def)].map((m) => modelInfo(m, "anthropic"))
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, { headers: await this.headers(), signal: AbortSignal.timeout(5000) })
      return res.ok
    } catch {
      return false
    }
  }
}

export async function streamFromRegistry(
  registry: ProviderRegistry,
  messages: ChatMessage[],
  opts?: { provider?: string; model?: string; stream?: StreamOptions },
): Promise<AsyncIterable<ProviderEvent>> {
  const role = opts?.model ? registry.resolveModel(opts.model) : undefined
  const provider = opts?.provider && registry.get(opts.provider)
  const adapter = provider ?? (role ? registry.get(role.provider) : registry.all()[0])
  if (!adapter) throw new Error("no provider available")
  const model = role?.id ?? opts?.model ?? (await adapter.listModels())[0]?.id
  if (!model) throw new Error("no model available")
  return adapter.stream(messages, model, opts?.stream)
}

