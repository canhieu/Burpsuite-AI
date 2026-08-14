export const TOOL_SCHEMA: string = `Available tools and exact argument schemas:

http.send — send a single HTTP request through Burp.
  arguments: {
    "ref": {"projectId": "<projectId>", "source": "proxy|siteMap|agent", "id": <number>}  // OR
    "request": {
      "startLine": "GET /path?x=1 HTTP/1.1",           // REQUIRED: full request line
      "headers": {"Host": "example.com", "Cookie": "..."},  // object; Host required if no httpService
      "body": "optional request body"
    },
    "httpService": {"host": "example.com", "port": 443, "secure": true},  // optional; derived from Host otherwise
    "via": "proxy"            // "proxy" = through Burp proxy (lands in HTTP History), "direct" = raw
  }
  returns: {"ref": ..., "statusCode": ..., "responseStartLine": ..., "headers": {...}, "body": "...", "bodyTruncated": ...}
  EXAMPLE: {"tool_call":{"name":"http.send","arguments":{"request":{"startLine":"GET /filter?category=Pets HTTP/1.1","headers":{"Host":"0a750005035beb4d8102118d00150070.web-security-academy.net"}}}}}

http.batch — send many requests concurrently. arguments: {"requests": [<http.send arguments objects>], "concurrency": 5}
http.race — send N copies of one request. arguments: {"base": <http.send arguments object>, "count": 20}
history.search — search Burp HTTP history. arguments: {"query": "text or url filter"}
payload.build — build a payload for a vuln class. arguments: {"vuln": "sqli|xss|ssti|ssrf|cmdi|traversal|jwt_tamper", "context": "..."}
finding.create — record a confirmed finding. arguments: {"title": "...", "vulnClass": "...", "severity": "low|medium|high|critical", "confidence": "tentative|medium|high|certain", "evidence": "...", "ref": {...}}
scan.crawl — run Burp crawler. arguments: {"url": "https://..."}
scan.audit — run Burp active scanner. arguments: {"url": "https://..."}
report.generate — build a report. arguments: {"program": "hackerone|bugcrowd|intigriti|immunefi", "findings": [finding ids], "format": "markdown|json"}
notify.send — send a notification. arguments: {"channel": "telegram|webhook", "message": "..."}

RULES:
- ALWAYS put the full request line in "startLine" (e.g. "GET /path HTTP/1.1"), never use method/target fields separately.
- Include "Host" header (or httpService) so the target is resolvable.
- Response bodies are redacted; don't echo secrets.
- After each tool result, plan the NEXT step and call the next tool. Do not stop until the objective is achieved.
`
