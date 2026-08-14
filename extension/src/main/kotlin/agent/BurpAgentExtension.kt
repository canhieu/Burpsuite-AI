package agent

import agent.rpc.Json
import burp.api.montoya.BurpExtension
import burp.api.montoya.MontoyaApi
import burp.api.montoya.scanner.audit.AuditIssueHandler
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class BurpAgentExtension : BurpExtension {

    private lateinit var ctx: AgentContext
    private val started = AtomicBoolean(false)
    private val bootstrap = Executors.newSingleThreadExecutor { r ->
        Thread(r, "agent-bootstrap").apply { isDaemon = true }
    }

    override fun initialize(api: MontoyaApi) {
        api.extension().setName("Burp Agent")

        ctx = AgentContext(api)
        ctx.handlers = Handlers(ctx)
        ctx.tab = AgentTab(ctx)
        api.userInterface().registerSuiteTab("Agent", ctx.tab!!.component())
        api.userInterface().registerContextMenuItemsProvider(ContextMenuProvider(ctx))

        api.scanner().registerAuditIssueHandler(object : AuditIssueHandler {
            override fun handleNewAuditIssue(issue: burp.api.montoya.scanner.audit.issues.AuditIssue) {
                ctx.globalIssues.add(issue)
            }
        })

        val rpc = RpcServer(ctx)
        ctx.rpcServer = rpc
        ctx.sidecar = SidecarManager(ctx)

        api.extension().registerUnloadingHandler {
            stopAll()
        }

        bootstrap.execute {
            startAll()
        }
    }

    private fun startAll() {
        if (!started.compareAndSet(false, true)) return
        val rpc = ctx.rpcServer ?: return
        try {
            rpc.start()
            ctx.audit.add("info", "rpc.listen", "ws://127.0.0.1:${rpc.port}", "ok")
        } catch (e: Exception) {
            ctx.audit.add("error", "rpc.listen", "failed to bind ws server", "failed", e.message ?: "")
            ctx.tab?.showError("failed to start rpc server: ${e.message}")
            return
        }
        ctx.sidecar?.start()
    }

    fun stopAll() {
        ctx.sidecar?.shutdown()
        ctx.rpcServer?.shutdown()
        ctx.policy.killAll.set(true)
        bootstrap.shutdownNow()
    }
}
