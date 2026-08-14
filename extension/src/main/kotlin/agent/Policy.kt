package agent

import java.net.URI
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

data class BudgetConfig(
    var requestCap: Int = 500,
    var durationSeconds: Long = 3600,
    var maxCostUsd: Double = 10.0,
)

sealed class SendDecision {
    data object Allow : SendDecision()
    data class Deny(val reason: String) : SendDecision()
}

sealed class RedirectDecision {
    data object Ok : RedirectDecision()
    data class Blocked(val target: String, val reason: String) : RedirectDecision()
}

class Policy(
    val isInScope: (String) -> Boolean,
    val budgetConfig: BudgetConfig = BudgetConfig(),
    val allowedOrigins: Set<String> = emptySet(),
    var mode: String = "manual",
) {
    val killAll = AtomicBoolean(false)
    private val requestsUsed = AtomicInteger(0)
    private val startedAtNanos = System.nanoTime()

    companion object {
        val SAFE_METHODS = setOf("GET", "HEAD", "OPTIONS")
        val DEFAULT_BLOCKLIST = listOf(
            "hackerone.com", "bugcrowd.com", "intigriti.com", "immunefi.com", "github.com"
        )
        val APPROVAL_REQUIRED = setOf(
            "scope.add", "scope.remove", "config.import", "proxy.set_intercept",
            "task_engine.pause", "task_engine.resume", "site_map.add",
            "scan.report", "bchecks.register", "scan.check.register"
        )

        fun domainOf(url: String): String? = try {
            URI(url).host
        } catch (e: Exception) {
            null
        }

        fun resolveRedirectUrl(location: String, baseUrl: String?): String? {
            return try {
                val base = if (baseUrl.isNullOrBlank()) null else URI(baseUrl)
                val uri = URI(location)
                if (uri.isAbsolute) {
                    uri.toString()
                } else if (base != null) {
                    base.resolve(uri).toString()
                } else {
                    null
                }
            } catch (e: Exception) {
                null
            }
        }
    }

    val blocklist: List<String> = DEFAULT_BLOCKLIST

    fun isBlockedUrl(url: String): String? {
        val host = domainOf(url) ?: return null
        val hostLower = host.lowercase()
        if (allowedOrigins.any { hostLower == it.lowercase() || hostLower.endsWith("." + it.lowercase()) }) return null
        val hit = blocklist.firstOrNull { b ->
            hostLower == b || hostLower.endsWith(".$b")
        }
        return hit?.let { "host blocklisted: $host" }
    }

    fun methodDecision(method: String): SendDecision {
        val m = method.uppercase()
        if (m in SAFE_METHODS) return SendDecision.Allow
        return if (mode == "autonomous") {
            SendDecision.Allow
        } else {
            SendDecision.Deny("state-changing method $method requires autonomous mode")
        }
    }

    fun budgetExceeded(): String? {
        if (requestsUsed.get() >= budgetConfig.requestCap) {
            return "request budget exceeded (cap ${budgetConfig.requestCap})"
        }
        val elapsedSec = (System.nanoTime() - startedAtNanos) / 1_000_000_000L
        if (budgetConfig.durationSeconds > 0 && elapsedSec >= budgetConfig.durationSeconds) {
            return "duration budget exceeded (cap ${budgetConfig.durationSeconds}s)"
        }
        return null
    }

    fun canSend(url: String, method: String): SendDecision {
        if (killAll.get()) return SendDecision.Deny("kill switch engaged")
        isBlockedUrl(url)?.let { return SendDecision.Deny(it) }
        if (!isInScope(url)) return SendDecision.Deny("url out of scope: $url")
        budgetExceeded()?.let { return SendDecision.Deny(it) }
        return methodDecision(method)
    }

    fun registerSend() {
        requestsUsed.incrementAndGet()
    }

    fun checkRedirect(location: String?, baseUrl: String?): RedirectDecision {
        if (location == null) return RedirectDecision.Ok
        val target = resolveRedirectUrl(location, baseUrl) ?: return RedirectDecision.Blocked(location, "unresolvable redirect target")
        isBlockedUrl(target)?.let { return RedirectDecision.Blocked(target, "redirect target blocklisted") }
        if (!isInScope(target)) return RedirectDecision.Blocked(target, "redirect out of scope")
        return RedirectDecision.Ok
    }

    fun requiresApproval(method: String): Boolean = method in APPROVAL_REQUIRED

    fun requestsUsed(): Int = requestsUsed.get()
}
