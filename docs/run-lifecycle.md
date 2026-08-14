# Run Lifecycle

How a run works end-to-end, from `agent.run.start` to completion, STOP ALL, resume,
and budget accounting.

## Orchestration loop

```
agent.run.start {task, skill?, mode, scope[], budget, models?, executors?, seedRefs?}
        │
        ▼
 Orchestrator (strong model)
   plan (visible): goals → step list → endpoint tasks
        │  spawns
        ▼
 Executors (N, cheaper model, own skill, own tool loop)
   step → tool call → observe → conclude
        │  push observations + candidate findings
        ▼
 shared findings pool (dedup lock, knowledge store)
        │
        ▼
 done → run.status = completed  (or cancelled / error)
```

- No hidden chain-of-thought in the UI — only goals, actions, observations, findings.
- `run.progress` events stream `{runId, step, done, message}`; `tool.call` events
  stream every tool invocation.
- A step that needs approval emits `approval.requested`; the run waits until the
  client replies `agent.approve {requestId, approved}`.

## Tool loop

1. Model proposes a tool call (or text).
2. Sidecar validates: skill allowlist → scope → budget → method gate → blocklist →
   redirect guard.
3. Mutating tools get an `idempotencyKey` (hash of run + call + target + payload);
   repeated keys return the cached result — provider retries never double-send.
4. Request goes to the extension via the RPC transport; extension performs redaction
   on the way back; result summary enters context as untrusted-tagged data.
5. Model observes and either concludes or proposes the next call.

## Executors

- One executor per endpoint task; each runs its own skill within a budget slice.
- Orchestrator allocates the global budget across executors
  (requests / tokens / cost).
- Executor failure → orchestrator resumes or reassigns the task.
- `executors` param caps parallelism (configurable); per-executor status exposed in
  `RunStatus.executors[]`.

## STOP ALL

- `agent.run.kill` (no runId) kills everything:
  1. Halt the orchestrator loop.
  2. Cancel in-flight request batches (cancellation token flows to the extension).
  3. Kill owned scan tasks (`scan.stop`).
  4. Persist run state to SQLite.
- The same teardown runs on extension unload / WebSocket drop — the run lifecycle
  is bound to Burp.
- The red **STOP ALL** button is always visible in the Runs view.

## Resume after restart

- State persisted to SQLite: plan, current step, per-executor status, requests/cost
  counters, findings, evidence refs.
- After Burp restarts, the extension respawns the sidecar; the UI offers
  "Resume last run" → sidecar reloads the persisted `RunStatus` and continues from
  the current step with remaining budget.
- Idempotency keys make resumed calls safe: already-executed mutations return
  cached results instead of re-running.

## Budget accounting

- Metrics tracked: requests, wall-clock duration, RPS, concurrency, tokens, cost USD.
- Caps come from `run.start.budget` and per-skill `limits`.
- A `budget.warning` event fires when a metric approaches its cap; the run pauses
  (auto-pause on error streaks too).
- Requests answered with `429 budget exceeded` when a cap is hit.
- Accounting is authoritative in the sidecar; the extension enforces the hard
  wall-clock cap locally as a backstop.
