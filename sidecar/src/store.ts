import { createRequire } from "node:module"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Evidence, Finding, MessageRef } from "./types.js"
import { newId, now } from "./util.js"

export interface RunRecord {
  runId: string
  status: string
  startedAt: number
  updatedAt: number
  data: Record<string, unknown>
}

export interface MessageRecord {
  projectId: string
  source: string
  id: string | number
  summary: string
  meta?: Record<string, unknown>
  createdAt: number
}

export interface EvidenceRecord {
  id: string
  findingId: string
  evidence: Evidence
  createdAt: number
}

export interface ToolLogEntry {
  id?: number
  ts: number
  tool: string
  result: unknown
}

export interface Store {
  readonly backend: "sqlite" | "json"
  close(): void

  saveRun(runId: string, data: Record<string, unknown>): void
  getRun(runId: string): RunRecord | undefined
  listRuns(): RunRecord[]

  putMessage(ref: MessageRef, summary: string, meta?: Record<string, unknown>): void
  getMessage(ref: MessageRef): MessageRecord | undefined
  searchMessages(q: { projectId?: string; host?: string; text?: string; limit?: number }): MessageRecord[]

  createFinding(finding: Finding): void
  updateFinding(finding: Finding): void
  getFinding(id: string): Finding | undefined
  listFindings(q?: { status?: string; program?: string }): Finding[]

  pinEvidence(findingId: string, evidence: Evidence): string
  getEvidence(findingId: string): EvidenceRecord[]

  logTool(tool: string, result: unknown): void
  getToolLog(limit?: number): ToolLogEntry[]

  getSetting(key: string): unknown
  setSetting(key: string, value: unknown): void
  getAllSettings(): Record<string, unknown>
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  project_id TEXT NOT NULL,
  source TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  meta TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, source, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at);
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_status ON findings (data);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_finding ON evidence (finding_id);
CREATE TABLE IF NOT EXISTS tool_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  tool TEXT NOT NULL,
  result TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

function refKey(ref: MessageRef): string {
  return `${ref.projectId}\u0000${ref.source}\u0000${String(ref.id)}`
}

export function createStore(dataDir: string, log?: (msg: string) => void): Store {
  const dir = resolve(dataDir)
  mkdirSync(dir, { recursive: true })

  const require = createRequire(import.meta.url)
  let Sqlite: typeof import("better-sqlite3") | null = null
  try {
    Sqlite = require("better-sqlite3") as typeof import("better-sqlite3")
  } catch {
    Sqlite = null
  }

  if (Sqlite) {
    try {
      return new SqliteStore(Sqlite, resolve(dir, "burp-agent.db"), log)
    } catch (err) {
      log?.(`sqlite store init failed, falling back to json: ${(err as Error).message}`)
    }
  } else {
    log?.("better-sqlite3 unavailable, using json file store")
  }
  return new JsonStore(resolve(dir, "store.json"), log)
}

class SqliteStore implements Store {
  readonly backend = "sqlite" as const
  private db: import("better-sqlite3").Database

  constructor(
    Sqlite: typeof import("better-sqlite3"),
    path: string,
    private log?: (msg: string) => void,
  ) {
    const db = new Sqlite(path)
    db.pragma("journal_mode = WAL")
    db.exec(SCHEMA)
    this.db = db
  }

  close(): void {
    this.db.close()
  }

  private jsonParse<T>(s: string | undefined | null): T | undefined {
    if (s === null || s === undefined) return undefined
    try {
      return JSON.parse(s) as T
    } catch {
      return undefined
    }
  }

  saveRun(runId: string, data: Record<string, unknown>): void {
    const t = now()
    const existing = this.db.prepare("SELECT data FROM runs WHERE id = ?").get(runId) as { data: string } | undefined
    if (existing) {
      this.db.prepare("UPDATE runs SET data = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(data), t, runId)
    } else {
      this.db.prepare("INSERT INTO runs (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)").run(runId, JSON.stringify(data), t, t)
    }
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as
      | { id: string; data: string; created_at: number; updated_at: number }
      | undefined
    if (!row) return undefined
    const data = this.jsonParse<Record<string, unknown>>(row.data) ?? {}
    return { runId: row.id, status: String(data["status"] ?? "unknown"), startedAt: row.created_at, updatedAt: row.updated_at, data }
  }

  listRuns(): RunRecord[] {
    const rows = this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all() as Array<{
      id: string
      data: string
      created_at: number
      updated_at: number
    }>
    return rows.map((r) => ({
      runId: r.id,
      status: String((this.jsonParse<Record<string, unknown>>(r.data) ?? {})["status"] ?? "unknown"),
      startedAt: r.created_at,
      updatedAt: r.updated_at,
      data: this.jsonParse<Record<string, unknown>>(r.data) ?? {},
    }))
  }

  putMessage(ref: MessageRef, summary: string, meta?: Record<string, unknown>): void {
    const t = now()
    this.db
      .prepare(
        `INSERT INTO messages (project_id, source, msg_id, summary, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, source, msg_id) DO UPDATE SET summary = excluded.summary, meta = excluded.meta`,
      )
      .run(ref.projectId, ref.source, String(ref.id), summary, meta ? JSON.stringify(meta) : null, t)
  }

  getMessage(ref: MessageRef): MessageRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM messages WHERE project_id = ? AND source = ? AND msg_id = ?")
      .get(ref.projectId, ref.source, String(ref.id)) as { project_id: string; source: string; msg_id: string; summary: string; meta: string | null; created_at: number } | undefined
    if (!row) return undefined
    return { projectId: row.project_id, source: row.source, id: row.msg_id, summary: row.summary, meta: this.jsonParse(row.meta), createdAt: row.created_at }
  }

  searchMessages(q: { projectId?: string; host?: string; text?: string; limit?: number }): MessageRecord[] {
    const clauses: string[] = []
    const args: unknown[] = []
    if (q.projectId) {
      clauses.push("project_id = ?")
      args.push(q.projectId)
    }
    if (q.host) {
      clauses.push("summary LIKE ?")
      args.push(`%${q.host}%`)
    }
    if (q.text) {
      clauses.push("(summary LIKE ? OR meta LIKE ?)")
      args.push(`%${q.text}%`, `%${q.text}%`)
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000)
    const rows = this.db.prepare(`SELECT * FROM messages ${where} ORDER BY created_at DESC LIMIT ?`).all(...args, limit) as Array<{
      project_id: string
      source: string
      msg_id: string
      summary: string
      meta: string | null
      created_at: number
    }>
    return rows.map((r) => ({ projectId: r.project_id, source: r.source, id: r.msg_id, summary: r.summary, meta: this.jsonParse(r.meta), createdAt: r.created_at }))
  }

  createFinding(finding: Finding): void {
    const t = now()
    this.db.prepare("INSERT INTO findings (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)").run(finding.id, JSON.stringify(finding), t, t)
  }

  updateFinding(finding: Finding): void {
    const t = now()
    this.db.prepare("UPDATE findings SET data = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(finding), t, finding.id)
  }

  getFinding(id: string): Finding | undefined {
    const row = this.db.prepare("SELECT data FROM findings WHERE id = ?").get(id) as { data: string } | undefined
    return row ? this.jsonParse<Finding>(row.data) : undefined
  }

  listFindings(q?: { status?: string; program?: string }): Finding[] {
    const rows = this.db.prepare("SELECT data FROM findings ORDER BY updated_at DESC").all() as Array<{ data: string }>
    return rows
      .map((r) => this.jsonParse<Finding>(r.data))
      .filter((f): f is Finding => !!f)
      .filter((f) => (!q?.status || f.status === q.status) && (!q?.program || f.program === q.program))
  }

  pinEvidence(findingId: string, evidence: Evidence): string {
    const id = newId("ev_")
    this.db.prepare("INSERT INTO evidence (id, finding_id, data, created_at) VALUES (?, ?, ?, ?)").run(id, findingId, JSON.stringify(evidence), now())
    return id
  }

  getEvidence(findingId: string): EvidenceRecord[] {
    const rows = this.db.prepare("SELECT * FROM evidence WHERE finding_id = ? ORDER BY created_at DESC").all(findingId) as Array<{
      id: string
      finding_id: string
      data: string
      created_at: number
    }>
    return rows
      .map((r) => ({ id: r.id, findingId: r.finding_id, evidence: this.jsonParse<Evidence>(r.data), createdAt: r.created_at }))
      .filter((e): e is EvidenceRecord => !!e.evidence)
  }

  logTool(tool: string, result: unknown): void {
    this.db.prepare("INSERT INTO tool_log (ts, tool, result) VALUES (?, ?, ?)").run(now(), tool, JSON.stringify(result))
  }

  getToolLog(limit = 100): ToolLogEntry[] {
    const rows = this.db.prepare("SELECT * FROM tool_log ORDER BY id DESC LIMIT ?").all(Math.min(limit, 500)) as Array<{
      id: number
      ts: number
      tool: string
      result: string
    }>
    return rows.map((r) => ({ id: r.id, ts: r.ts, tool: r.tool, result: this.jsonParse(r.result) }))
  }

  getSetting(key: string): unknown {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined
    return row ? this.jsonParse(row.value) : undefined
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(key, JSON.stringify(value), now())
  }

  getAllSettings(): Record<string, unknown> {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>
    const out: Record<string, unknown> = {}
    for (const r of rows) out[r.key] = this.jsonParse(r.value)
    return out
  }
}

interface JsonFile {
  runs: Record<string, RunRecord>
  messages: Record<string, MessageRecord>
  findings: Record<string, Finding>
  evidence: Record<string, EvidenceRecord>
  tool_log: ToolLogEntry[]
  settings: Record<string, unknown>
}

function emptyJsonFile(): JsonFile {
  return { runs: {}, messages: {}, findings: {}, evidence: {}, tool_log: [], settings: {} }
}

class JsonStore implements Store {
  readonly backend = "json" as const
  private data: JsonFile
  private dirty = false

  constructor(
    private path: string,
    private log?: (msg: string) => void,
  ) {
    this.data = emptyJsonFile()
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as JsonFile
        this.data = { ...emptyJsonFile(), ...parsed }
      } catch {
        this.log?.(`json store corrupt, starting empty: ${path}`)
      }
    }
    this.persist()
  }

  close(): void {
    this.persist()
  }

  private persist(): void {
    if (this.dirty || !existsSync(this.path)) {
      writeFileSync(this.path, JSON.stringify(this.data, null, 2))
      this.dirty = false
    }
  }

  saveRun(runId: string, data: Record<string, unknown>): void {
    const prev = this.data.runs[runId]
    this.data.runs[runId] = {
      runId,
      status: String(data["status"] ?? prev?.status ?? "unknown"),
      startedAt: prev?.startedAt ?? now(),
      updatedAt: now(),
      data,
    }
    this.dirty = true
    this.persist()
  }

  getRun(runId: string): RunRecord | undefined {
    return this.data.runs[runId]
  }

  listRuns(): RunRecord[] {
    return Object.values(this.data.runs).sort((a, b) => b.startedAt - a.startedAt)
  }

  putMessage(ref: MessageRef, summary: string, meta?: Record<string, unknown>): void {
    this.data.messages[refKey(ref)] = { projectId: ref.projectId, source: ref.source, id: ref.id, summary, meta, createdAt: now() }
    this.dirty = true
    this.persist()
  }

  getMessage(ref: MessageRef): MessageRecord | undefined {
    return this.data.messages[refKey(ref)]
  }

  searchMessages(q: { projectId?: string; host?: string; text?: string; limit?: number }): MessageRecord[] {
    let items = Object.values(this.data.messages).sort((a, b) => b.createdAt - a.createdAt)
    if (q.projectId) items = items.filter((m) => m.projectId === q.projectId)
    if (q.host) items = items.filter((m) => m.summary.includes(q.host!))
    if (q.text) items = items.filter((m) => m.summary.includes(q.text!) || JSON.stringify(m.meta ?? {}).includes(q.text!))
    return items.slice(0, Math.min(Math.max(q.limit ?? 100, 1), 1000))
  }

  createFinding(finding: Finding): void {
    this.data.findings[finding.id] = finding
    this.dirty = true
    this.persist()
  }

  updateFinding(finding: Finding): void {
    this.data.findings[finding.id] = finding
    this.dirty = true
    this.persist()
  }

  getFinding(id: string): Finding | undefined {
    return this.data.findings[id]
  }

  listFindings(q?: { status?: string; program?: string }): Finding[] {
    return Object.values(this.data.findings)
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .filter((f) => (!q?.status || f.status === q.status) && (!q?.program || f.program === q.program))
  }

  pinEvidence(findingId: string, evidence: Evidence): string {
    const id = newId("ev_")
    this.data.evidence[id] = { id, findingId, evidence, createdAt: now() }
    this.dirty = true
    this.persist()
    return id
  }

  getEvidence(findingId: string): EvidenceRecord[] {
    return Object.values(this.data.evidence)
      .filter((e) => e.findingId === findingId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  logTool(tool: string, result: unknown): void {
    this.data.tool_log.push({ ts: now(), tool, result })
    if (this.data.tool_log.length > 5000) this.data.tool_log = this.data.tool_log.slice(-5000)
    this.dirty = true
    this.persist()
  }

  getToolLog(limit = 100): ToolLogEntry[] {
    return this.data.tool_log.slice(0, Math.min(limit, 500)).map((e, i) => ({ ...e, id: i }))
  }

  getSetting(key: string): unknown {
    return this.data.settings[key]
  }

  setSetting(key: string, value: unknown): void {
    this.data.settings[key] = value
    this.dirty = true
    this.persist()
  }

  getAllSettings(): Record<string, unknown> {
    return { ...this.data.settings }
  }
}
