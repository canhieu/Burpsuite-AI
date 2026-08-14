package agent

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PolicyTest {

    private fun policy(mode: String = "manual", inScope: (String) -> Boolean = { it.contains("example.com") }) =
        Policy(isInScope = inScope, mode = mode)

    @Test
    fun `safe methods always allowed in manual mode`() {
        val p = policy()
        assertTrue(p.canSend("http://example.com/", "GET") is SendDecision.Allow)
        assertTrue(p.canSend("http://example.com/", "HEAD") is SendDecision.Allow)
        assertTrue(p.canSend("http://example.com/", "OPTIONS") is SendDecision.Allow)
    }

    @Test
    fun `state changing methods denied in manual mode`() {
        val p = policy()
        val d = p.canSend("http://example.com/", "POST")
        assertTrue(d is SendDecision.Deny)
    }

    @Test
    fun `state changing methods allowed in autonomous mode`() {
        val p = policy(mode = "autonomous")
        assertTrue(p.canSend("http://example.com/", "POST") is SendDecision.Allow)
        assertTrue(p.canSend("http://example.com/", "DELETE") is SendDecision.Allow)
    }

    @Test
    fun `out of scope denied`() {
        val p = policy()
        val d = p.canSend("http://evil.com/x", "GET")
        assertTrue(d is SendDecision.Deny)
        assertTrue((d as SendDecision.Deny).reason.contains("scope"))
    }

    @Test
    fun `blocklist rejects platform domains`() {
        val p = policy()
        assertEquals("host blocklisted: hackerone.com", p.isBlockedUrl("https://hackerone.com/reports"))
        assertTrue(p.canSend("https://bugcrowd.com/a", "GET") is SendDecision.Deny)
        assertTrue(p.canSend("https://sub.immunefi.com/x", "GET") is SendDecision.Deny)
    }

    @Test
    fun `allowed origins override blocklist`() {
        val p = Policy(isInScope = { true }, allowedOrigins = setOf("hackerone.com"))
        assertEquals(null, p.isBlockedUrl("https://hackerone.com/x"))
        assertEquals(null, p.isBlockedUrl("https://hackerone.com/sub/path"))
    }

    @Test
    fun `github blocklisted unless allowed`() {
        val p = policy()
        assertTrue(p.isBlockedUrl("https://github.com/org/repo") != null)
    }

    @Test
    fun `redirect out of scope blocked`() {
        val p = policy(inScope = { it.contains("example.com") })
        val d = p.checkRedirect("http://evil.com/steal", "https://example.com/app")
        assertTrue(d is RedirectDecision.Blocked)
        assertTrue((d as RedirectDecision.Blocked).reason.contains("redirect out of scope"))
    }

    @Test
    fun `redirect to in-scope allowed`() {
        val p = policy(inScope = { it.contains("example.com") })
        assertTrue(p.checkRedirect("https://example.com/login", "https://example.com/app") is RedirectDecision.Ok)
    }

    @Test
    fun `relative redirect resolves against base`() {
        val p = policy(inScope = { it.contains("example.com") })
        assertTrue(p.checkRedirect("/login", "https://example.com/app/page") is RedirectDecision.Ok)
    }

    @Test
    fun `no location means ok`() {
        val p = policy()
        assertTrue(p.checkRedirect(null, null) is RedirectDecision.Ok)
    }

    @Test
    fun `kill switch stops everything`() {
        val p = policy(mode = "autonomous")
        p.killAll.set(true)
        val d = p.canSend("http://example.com/", "GET")
        assertTrue(d is SendDecision.Deny)
    }

    @Test
    fun `budget cap denies after cap reached`() {
        val p = Policy(isInScope = { true }, budgetConfig = BudgetConfig(requestCap = 2))
        p.registerSend()
        p.registerSend()
        val d = p.canSend("http://example.com/", "GET")
        assertTrue(d is SendDecision.Deny)
        assertTrue((d as SendDecision.Deny).reason.contains("budget"))
    }

    @Test
    fun `approval required list includes high risk methods`() {
        val p = policy()
        assertTrue(p.requiresApproval("scope.add"))
        assertTrue(p.requiresApproval("scope.remove"))
        assertTrue(p.requiresApproval("config.import"))
        assertTrue(p.requiresApproval("proxy.set_intercept"))
        assertTrue(p.requiresApproval("task_engine.pause"))
        assertTrue(p.requiresApproval("task_engine.resume"))
        assertTrue(p.requiresApproval("site_map.add"))
        assertTrue(p.requiresApproval("scan.report"))
        assertTrue(p.requiresApproval("bchecks.register"))
        assertTrue(p.requiresApproval("scan.check.register"))
        assertTrue(!p.requiresApproval("history.search"))
        assertTrue(!p.requiresApproval("http.send"))
    }
}
