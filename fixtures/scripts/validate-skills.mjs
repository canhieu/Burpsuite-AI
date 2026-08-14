import { readdirSync, readFileSync, existsSync } from "node:fs"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import yaml from "js-yaml"

const __dirname = resolve(fileURLToPath(import.meta.url), "..")
const builtinDir = resolve(__dirname, "../../skills/builtin")

const requiredKeys = ["id", "version", "name", "description", "workflow", "prompt"]
const stringKeys = ["id", "version", "name", "description", "modelPreference", "authRequired", "approvalPolicy", "workflow", "prompt"]
const authValues = ["anon", "accountA", "accountB", "dual"]
const approvalValues = ["auto", "approval"]

const errors = []
let checked = 0

for (const folder of readdirSync(builtinDir)) {
  const dir = join(builtinDir, folder)
  const yamlPath = join(dir, "skill.yaml")
  const promptPath = join(dir, "PROMPT.md")
  if (!existsSync(yamlPath)) {
    errors.push(`${folder}: missing skill.yaml`)
    continue
  }
  if (!existsSync(promptPath)) {
    errors.push(`${folder}: missing PROMPT.md`)
  }

  let doc
  try {
    doc = yaml.load(readFileSync(yamlPath, "utf8"))
  } catch (err) {
    errors.push(`${folder}: yaml parse error: ${err.message}`)
    continue
  }
  checked++

  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    errors.push(`${folder}: skill.yaml must be a mapping`)
    continue
  }
  const skill = doc

  for (const key of requiredKeys) {
    if (!(key in skill)) errors.push(`${folder}: missing required key '${key}'`)
    else if (typeof skill[key] !== "string" || skill[key].trim() === "") {
      errors.push(`${folder}: '${key}' must be a non-empty string`)
    }
  }

  for (const key of stringKeys) {
    if (key in skill && typeof skill[key] !== "string") {
      errors.push(`${folder}: '${key}' must be a string`)
    }
  }

  if ("triggers" in skill) {
    if (!Array.isArray(skill.triggers) || skill.triggers.some((t) => typeof t !== "string")) {
      errors.push(`${folder}: 'triggers' must be an array of strings`)
    }
  }

  if ("tools" in skill) {
    const tools = skill.tools
    if (typeof tools !== "object" || tools === null) {
      errors.push(`${folder}: 'tools' must be an object`)
    } else {
      for (const side of ["allow", "deny"]) {
        if (side in tools) {
          if (!Array.isArray(tools[side]) || tools[side].some((t) => typeof t !== "string")) {
            errors.push(`${folder}: 'tools.${side}' must be an array of strings`)
          } else if (side === "allow" && tools[side].length === 0) {
            errors.push(`${folder}: 'tools.allow' must not be empty`)
          }
        }
      }
      if (Array.isArray(tools.allow) && Array.isArray(tools.deny)) {
        const overlap = tools.allow.filter((t) => tools.deny.includes(t))
        if (overlap.length > 0) errors.push(`${folder}: tools.allow and tools.deny overlap: ${overlap.join(", ")}`)
      }
    }
  }

  if ("limits" in skill) {
    const limits = skill.limits
    if (typeof limits !== "object" || limits === null) {
      errors.push(`${folder}: 'limits' must be an object`)
    } else {
      for (const key of ["requests", "durationSeconds", "concurrency", "maxCostUsd"]) {
        if (key in limits && typeof limits[key] !== "number") {
          errors.push(`${folder}: 'limits.${key}' must be a number`)
        }
      }
    }
  }

  if ("authRequired" in skill && !authValues.includes(skill.authRequired)) {
    errors.push(`${folder}: 'authRequired' must be one of ${authValues.join(", ")}`)
  }
  if ("approvalPolicy" in skill && !approvalValues.includes(skill.approvalPolicy)) {
    errors.push(`${folder}: 'approvalPolicy' must be one of ${approvalValues.join(", ")}`)
  }
}

if (errors.length > 0) {
  console.error(`skills: FAIL (${checked} checked, ${errors.length} error(s))`)
  for (const err of errors) console.error(`  - ${err}`)
  process.exit(1)
}
console.log(`skills: OK (${checked} skill.yaml parsed and validated)`)
