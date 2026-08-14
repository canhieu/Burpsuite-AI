import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface AuthTokens {
  access_token?: string
  refresh_token?: string
  id_token?: string
  account_id?: string
  expires_at?: number
}

export interface CredentialFile {
  path: string
  /** Load+parse the file. Returns undefined if missing or unreadable. */
  load(): Promise<Record<string, unknown> | undefined>
  /** Atomic write (tmp+rename) with 0600 perms on unix. */
  save(json: Record<string, unknown>): Promise<void>
  /** Best-effort delete. Returns true if it existed. */
  delete(): Promise<boolean>
}

function codexHomeEnv(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex")
}

function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
}

export function codexAuthPath(): string {
  return join(codexHomeEnv(), "auth.json")
}

export function claudeCredentialsPath(): string {
  return join(claudeHome(), ".credentials.json")
}

export function createCredentialFile(path: string): CredentialFile {
  return {
    path,
    async load() {
      try {
        const raw = await fs.readFile(path, "utf8")
        return JSON.parse(raw) as Record<string, unknown>
      } catch {
        return undefined
      }
    },
    async save(json) {
      await fs.mkdir(join(path, ".."), { recursive: true })
      const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
      await fs.writeFile(tmp, JSON.stringify(json, null, 2), { mode: 0o600 })
      await fs.rename(tmp, path)
    },
    async delete() {
      try {
        await fs.unlink(path)
        return true
      } catch {
        return false
      }
    },
  }
}

export interface OAuthConfig {
  issuer: string
  clientId: string
  scope: string
  tokenEndpoint: string
  deviceEndpoint?: string
  authorizeEndpoint?: string
  redirectUri?: string
  checkEndpoint?: string
}

/** Parse OAuth tokens out of a token-response body (snake_case) into AuthTokens. */
export function normalizeTokenResponse(body: Record<string, unknown>, now = Date.now()): AuthTokens {
  const expiresIn = typeof body["expires_in"] === "number" ? body["expires_in"] : undefined
  return {
    access_token: typeof body["access_token"] === "string" ? body["access_token"] : undefined,
    refresh_token: typeof body["refresh_token"] === "string" ? body["refresh_token"] : undefined,
    id_token: typeof body["id_token"] === "string" ? body["id_token"] : undefined,
    account_id: typeof body["account_id"] === "string" ? body["account_id"] : undefined,
    expires_at: expiresIn ? now + expiresIn * 1000 : undefined,
  }
}
