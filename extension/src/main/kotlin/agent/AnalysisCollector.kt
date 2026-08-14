package agent

import agent.http.RawHttpMessage
import agent.rpc.Json
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Collects proxy/agent traffic, runs cheap heuristic triage on every pair,
 * and submits high-signal bundles to the sidecar LLM analyzer (background).
 * Dedupes by fingerprint so the same endpoint isn't re-analyzed repeatedly.
 */
class AnalysisCollector(private val ctx: AgentContext) {

    @Volatile
    var enabled: Boolean = true
        set(value) {
            field = value
            if (!value) pending.clear()
        }

    @Volatile
    var llmEnabled: Boolean = true

    /** Minimum heuristic score to warrant LLM analysis. */
    @Volatile
    var threshold: Int = 5

    private val seen = ConcurrentHashMap<String, Long>()
    private val pending = ConcurrentHashMap.newKeySet<String>()
    private val executor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "analysis-collector").apply { isDaemon = true }
    }
    private val flushing = AtomicBoolean(false)
    private val maxPending = 64

    private val listeners = CopyOnWriteArrayListListener<SignalBundle>()

    init {
        executor.scheduleWithFixedDelay({ flush() }, 5, 5, TimeUnit.SECONDS)
    }

    /** Called for every request/response pair (proxy traffic + agent http.send). */
    fun capture(request: RawHttpMessage, response: RawHttpMessage?, url: String, method: String) {
        if (!enabled) return
        val bundle = HeuristicAnalyzer.analyze(request, response, url, method)
        listeners.notify(bundle)

        val now = System.currentTimeMillis()
        val last = seen[bundle.fingerprint]
        if (last != null && now - last < 10 * 60 * 1000L) return // dedupe TTL 10 min
        seen[bundle.fingerprint] = now

        if (!llmEnabled || bundle.score < threshold) return
        if (pending.size >= maxPending) return
        if (pending.add(bundle.fingerprint)) queue(bundle)
    }

    private fun queue(bundle: SignalBundle) {
        executor.execute {
            val payload = Json.obj(
                "fingerprint" to bundle.fingerprint,
                "method" to bundle.method,
                "url" to bundle.url,
                "status" to bundle.status,
                "score" to bundle.score,
                "flags" to bundle.flags,
                "reflection" to bundle.reflection,
                "requestDigest" to bundle.requestDigest,
                "responseDigest" to bundle.responseDigest,
            )
            ctx.rpcServer?.callSidecar("analysis.submit", payload, timeoutMs = 15000)
            pending.remove(bundle.fingerprint)
        }
    }

    fun flush() {
        if (flushing.compareAndSet(false, true)) {
            try {
                // currently nothing buffered beyond the per-item executor; kept for debounce hook
            } finally {
                flushing.set(false)
            }
        }
    }

    /** For heuristic-only consumers (UI). */
    fun addListener(l: (SignalBundle) -> Unit) {
        listeners.add(l)
    }

    fun shutdown() {
        enabled = false
        executor.shutdownNow()
    }
}

class CopyOnWriteArrayListListener<T> {
    private val list = java.util.concurrent.CopyOnWriteArrayList<(T) -> Unit>()
    fun add(l: (T) -> Unit) = list.add(l)
    fun notify(value: T) {
        for (l in list) runCatching { l(value) }
    }
}
