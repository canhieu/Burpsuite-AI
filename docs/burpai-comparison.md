# Burp AI / Burp AT Comparison

From PLAN.md section 18. Coverage status per milestone:

| Burp AI / AT feature | Status |
|---|---|
| Chat with selected request/response (Proxy/Repeater/Target) | ✅ M1 |
| Explain / Analyze request & response | ✅ M1 |
| Proxy history as chat context | ✅ M2 |
| Local LLM (no external data) | ✅ local-only mode |
| Custom prompts | ✅ prompt library (M1) |
| Ask about selected text | ✅ M1 |
| AI-generated attack payloads | ✅ M6 payload bank |
| Per-chat tool permissions | ✅ per-chat tool toggle (M3) |
| Multiple parallel conversations | ✅ Tasks |
| Burp AT: AI-authored bChecks → Scanner → AI review loop | ✅ BCheck author loop (M6/M7) |
| Burp AT: live plan view + cancel mid-run | ✅ Runs view |
| Burp AT: test specific request(s) autonomously | ✅ M4/M6 |
| Explain/triage existing Scanner issues | ✅ issue-explainer (M5) |
| Issues to Dashboard | ✅ `SiteMap.add` (M9) |
| Collaborator OOB | ✅ M6 |
| Prompt-injection defense | ✅ 3-layer isolation |

## Beyond Burp AI

- Multi-provider + per-role models (OpenAI/Codex, Anthropic, DeepSeek, Ollama/vLLM/LM Studio).
- OAuth shared with Codex CLI / Claude Code (shared credential files).
- Open skills + importers; built-in bug-bounty skill catalog.
- Full Burp tool control: Intruder / Comparer / Organizer / Scope / SiteMap.
- Proxy-listener routing — agent requests land in Proxy history.
- No PortSwigger quota dependency.

## Not possible (API limits)

- Burp AT/AI proprietary internals.
- Sequencer.
- Decoder (reimplemented in the sidecar as `payload.*`).
- Intruder auto-launch (agent uses internal batch/race instead; Intruder is for human handoff).
- Repeater read-back.
- GUI automation.
