package agent

import agent.http.Header
import agent.http.RawHttpMessage
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

        registerProxyAnalysis(api)

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
        ctx.analysis.shutdown()
        bootstrap.shutdownNow()
    }

    private fun registerProxyAnalysis(api: MontoyaApi) {
        try {
            api.proxy().registerResponseHandler(object : burp.api.montoya.proxy.http.ProxyResponseHandler {
                override fun handleResponseReceived(interceptedResponse: burp.api.montoya.proxy.http.InterceptedResponse): burp.api.montoya.proxy.http.ProxyResponseReceivedAction {
                    return burp.api.montoya.proxy.http.ProxyResponseReceivedAction.continueWith(interceptedResponse)
                }

                override fun handleResponseToBeSent(interceptedResponse: burp.api.montoya.proxy.http.InterceptedResponse): burp.api.montoya.proxy.http.ProxyResponseToBeSentAction {
                    try {
                        val req = interceptedResponse.request()
                        if (req != null) {
                            val reqRaw = RawHttpMessage.of(
                                "${req.method().toString()} ${req.path()} HTTP/1.1",
                                req.headers().map { Header(it.name(), it.value()) },
                                req.body().getBytes(),
                            )
                            val respRaw = RawHttpMessage.of(
                                "HTTP/1.1 ${interceptedResponse.statusCode()} ${interceptedResponse.reasonPhrase()}",
                                interceptedResponse.headers().map { Header(it.name(), it.value()) },
                                interceptedResponse.body().getBytes(),
                            )
                            ctx.analysis.capture(reqRaw, respRaw, req.url(), req.method().toString())
                        }
                    } catch (e: Exception) {
                        // non-fatal; never block proxy flow
                    }
                    return burp.api.montoya.proxy.http.ProxyResponseToBeSentAction.continueWith(interceptedResponse)
                }
            })
            ctx.audit.add("info", "analysis.proxy", "proxy response handler registered", "ok")
        } catch (e: Exception) {
            ctx.audit.add("error", "analysis.proxy", "failed to register proxy handler", "failed", e.message ?: "")
        }
    }
}
