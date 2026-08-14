import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Finding } from "../types.js"
import { RpcError } from "./types.js"
import type { HandlerGroup } from "./types.js"

const SEVERITY_ORDER: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 }

interface PlatformSpec {
  name: string
  sections: Array<{
    heading: string
    render: (f: Finding) => string
  }>
}

function renderStandard(f: Finding, sections: Array<{ heading: string; render: (f: Finding) => string }>): string {
  const lines: string[] = [`# ${f.title}`, ""]
  lines.push(`**Weakness:** ${f.vulnClass}`)
  lines.push(`**Severity:** ${f.severity}`)
  lines.push(`**Confidence:** ${f.confidence}`)
  lines.push(`**Status:** ${f.status}`)
  if (f.assets?.length) lines.push(`**Asset:** ${f.assets.join(", ")}`)
  if (f.skill) lines.push(`**Skill:** ${f.skill}`)
  if (f.program) lines.push(`**Program:** ${f.program}`)
  lines.push("", "---", "")
  for (const s of sections) {
    lines.push(`## ${s.heading}`, "", s.render(f), "")
  }
  return lines.join("\n")
}

const PLATFORMS: Record<string, PlatformSpec> = {
  hackerone: {
    name: "HackerOne",
    sections: [
      {
        heading: "Summary",
        render: (f) => `A ${f.severity} severity issue of type **${f.vulnClass}** was identified in ${f.assets?.join(", ") || "the target asset"}.`,
      },
      {
        heading: "Vulnerability Details",
        render: (f) => `Weakness class: ${f.vulnClass}\n\nObserved confidence: ${f.confidence}.`,
      },
      {
        heading: "Steps to Reproduce",
        render: () => `1. Identify the affected endpoint.\n2. Reproduce the issue using the pinned evidence.\n3. Observe the vulnerable behavior.\n\n(Detailed reproduction steps pending.)`,
      },
      { heading: "Impact", render: (f) => `Impact is rated as **${f.severity}** for weakness class ${f.vulnClass}.` },
      { heading: "Recommendation", render: (f) => `Apply input validation and output encoding appropriate to ${f.vulnClass}, and retest.` },
    ],
  },
  bugcrowd: {
    name: "Bugcrowd",
    sections: [
      {
        heading: "Title",
        render: (f) => f.title,
      },
      {
        heading: "Vulnerability Description",
        render: (f) => `Weakness class: ${f.vulnClass}. Confidence: ${f.confidence}. Evidence references: ${f.evidence.length} pinned item(s).`,
      },
      {
        heading: "Steps to Reproduce",
        render: () => `1. Reproduce the behavior using the pinned evidence.\n2. Confirm the vulnerable state.\n\n(Detailed reproduction steps pending.)`,
      },
      {
        heading: "Proof of Concept",
        render: (f) => (f.evidence.length ? `See pinned evidence items for this finding (${f.id}).` : "No evidence pinned yet."),
      },
      { heading: "Impact", render: (f) => `Rated **${f.severity}**.` },
    ],
  },
  intigriti: {
    name: "Intigriti",
    sections: [
      {
        heading: "Vulnerability Description",
        render: (f) => `**Class:** ${f.vulnClass}\n\n**Severity:** ${f.severity}\n\n**Confidence:** ${f.confidence}`,
      },
      {
        heading: "Steps to Reproduce",
        render: () => `1. Access the target.\n2. Trigger the issue using the pinned evidence.\n3. Confirm the impact.\n\n(Detailed reproduction steps pending.)`,
      },
      {
        heading: "Affected Asset",
        render: (f) => f.assets?.join(", ") || "not specified",
      },
      {
        heading: "Impact",
        render: (f) => `Impact assessed as ${f.severity} for ${f.vulnClass}.`,
      },
      { heading: "Recommended Fix", render: () => "Validate and sanitize all untrusted input; follow platform-specific remediation guidance." },
    ],
  },
  immunefi: {
    name: "Immunefi",
    sections: [
      {
        heading: "Summary",
        render: (f) => `**${f.vulnClass}** at ${f.assets?.join(", ") || "target"}, rated ${f.severity}.`,
      },
      {
        heading: "Vulnerability Details",
        render: (f) => `Weakness class: ${f.vulnClass}. Confidence: ${f.confidence}.`,
      },
      {
        heading: "Steps to Reproduce",
        render: () => `1. Reproduce using pinned evidence.\n2. Confirm vulnerable behavior.\n\n(Detailed reproduction steps pending.)`,
      },
      {
        heading: "Impact",
        render: (f) => `Severity: **${f.severity}**. Proof required: pinned evidence (${f.evidence.length} items).`,
      },
      { heading: "Recommendation", render: () => "Apply the appropriate fix for the weakness class and re-verify." },
    ],
  },
}

export function reportHandlers(): HandlerGroup {
  return {
    "report.generate": (params, _c, services) => {
      const program = String(params["program"] ?? "").toLowerCase()
      const platform = PLATFORMS[program]
      if (!platform) throw new RpcError(400, `unsupported program: ${program}`)
      const ids = Array.isArray(params["findingIds"]) ? (params["findingIds"] as string[]) : []
      const findings = ids.map((id) => services.store.getFinding(id)).filter((f): f is Finding => !!f)
      if (ids.length && findings.length === 0) throw new RpcError(404, "no findings found for report")

      const parts: string[] = [
        `# Vulnerability Report — ${platform.name}`,
        "",
        `Generated: ${new Date().toISOString()}`,
        `Program: ${program}`,
        `Findings: ${findings.length}`,
        "",
        "---",
        "",
      ]
      const sorted = [...findings].sort(
        (a, b) => (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0),
      )
      for (const f of sorted) {
        parts.push(renderStandard(f, platform.sections))
        parts.push("---", "")
      }
      const markdown = parts.join("\n")

      const outPath = typeof params["outPath"] === "string" ? params["outPath"] : undefined
      if (outPath) {
        try {
          writeFileSync(resolve(outPath), markdown)
        } catch (err) {
          services.log("warn", `report.write failed: ${(err as Error).message}`)
          return { markdown, written: false, error: "failed to write outPath" }
        }
      }
      return { markdown, written: !!outPath, program }
    },
  }
}
