package agent

import agent.rpc.Json
import agent.rpc.RpcError
import agent.rpc.RpcFailure
import agent.rpc.RpcIncoming
import agent.rpc.RpcMessage
import agent.rpc.SidecarReply
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import java.io.IOException
import java.net.InetSocketAddress
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

class RpcServer(
    private val ctx: AgentContext,
    host: String = "127.0.0.1",
) : WebSocketServer(InetSocketAddress(host, 0)) {

    companion object {
        const val VERSION = "0.1.0"
    }

    private val pool = Executors.newFixedThreadPool(4) { r ->
        Thread(r, "burp-agent-rpc").apply { isDaemon = true }
    }
    private val requestIds = AtomicLong(1)
    private val pending = ConcurrentHashMap<Any, CompletableFuture<SidecarReply>>()

    @Volatile
    private var session: WebSocket? = null

    @Volatile
    var handshaken: Boolean = false
        private set

    val token: String
    val nonce: String

    init {
        token = System.getenv("BURP_AGENT_TOKEN")?.takeIf { it.isNotBlank() }
            ?: "agent-" + java.util.UUID.randomUUID().toString()
        nonce = "nonce-" + java.util.UUID.randomUUID().toString()
    }

    fun isConnected(): Boolean = handshaken && session?.isOpen == true

    fun nextRequestId(): Long = requestIds.getAndIncrement()

    fun callSidecar(method: String, params: JsonObject?, timeoutMs: Long = 30000): SidecarReply {
        val s = session
        if (s == null || !isConnected()) return SidecarReply(null, RpcError(503, "sidecar not connected"))
        val id = requestIds.getAndIncrement()
        val fut = CompletableFuture<SidecarReply>()
        pending[id] = fut
        s.send(RpcMessage.request(id, method, params ?: JsonObject()))
        return try {
            fut.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: Exception) {
            SidecarReply(null, RpcError(408, "sidecar call timeout: $method"))
        } finally {
            pending.remove(id)
        }
    }

    fun sendNotification(method: String, params: JsonObject) {
        val s = session
        if (s != null && isConnected()) {
            s.send(RpcMessage.notification(method, params))
        }
    }

    override fun onOpen(conn: WebSocket, handshake: ClientHandshake) {
        session = conn
        handshaken = false
    }

    override fun onMessage(conn: WebSocket, message: String) {
        val incoming = try {
            RpcMessage.parse(message)
        } catch (e: Exception) {
            null
        } ?: run {
            conn.send(RpcMessage.responseError(null, -32700, "parse error"))
            return
        }

        when (incoming) {
            is RpcIncoming.Request -> pool.execute { handleIncomingRequest(conn, incoming) }
            is RpcIncoming.Notification -> handleNotification(conn, incoming)
            is RpcIncoming.Response -> handleIncomingResponse(incoming)
        }
    }

    override fun onClose(conn: WebSocket, code: Int, reason: String, remote: Boolean) {
        if (session === conn) {
            session = null
            handshaken = false
        }
        failAllPending(RpcError(503, "sidecar connection closed"))
        ctx.onSidecarDisconnected()
    }

    override fun onError(conn: WebSocket, ex: Exception) {
        ex.printStackTrace()
    }

    override fun onStart() {
        log("RpcServer listening on ${address.address.hostAddress}:$port")
    }

    private fun handleIncomingRequest(conn: WebSocket, req: RpcIncoming.Request) {
        if (!handshaken) {
            conn.send(RpcMessage.responseError(req.id, 401, "not handshaken"))
            conn.close()
            return
        }
        try {
            val result = ctx.handlers?.dispatch(req.id, req.method, req.params)
            conn.send(RpcMessage.response(req.id, result))
        } catch (e: RpcFailure) {
            conn.send(RpcMessage.responseError(req.id, e.code, e.message, e.data))
        } catch (e: Exception) {
            log("rpc error handling ${req.method}: ${e.message}")
            conn.send(RpcMessage.responseError(req.id, -32603, "internal error: ${e.message}"))
        }
    }

    private fun handleIncomingResponse(resp: RpcIncoming.Response) {
        val fut = pending.remove(resp.id)
        if (fut != null) {
            fut.complete(SidecarReply(resp.result, resp.error))
        }
    }

    private fun handleNotification(conn: WebSocket, notif: RpcIncoming.Notification) {
        if (!handshaken) {
            handleHandshake(conn, notif)
            return
        }
        when (notif.method) {
            "agent.approve" -> {
                val requestId = notif.params.get("requestId")?.asString
                val approved = notif.params.get("approved")?.asBoolean
                if (requestId != null && approved != null) {
                    ctx.approvalBroker.resolve(requestId, approved)
                }
            }
            "approval.requested" -> ctx.onSidecarEvent(notif.method, notif.params)
            "agent.event", "run.progress", "tool.call", "finding.updated", "auth.status.changed",
            "budget.warning", "run.status" -> ctx.onSidecarEvent(notif.method, notif.params)
            "agent.hello" -> {
                ctx.onSidecarConnected(notif.params.get("version")?.takeIf { !it.isJsonNull }?.asString ?: "?")
            }
            else -> {
                log("unhandled notification from sidecar: ${notif.method}")
                ctx.onSidecarEvent(notif.method, notif.params)
            }
        }
    }

    private fun handleHandshake(conn: WebSocket, notif: RpcIncoming.Notification) {
        if (notif.method != "handshake.hello") {
            conn.send(RpcMessage.responseError(null, 401, "expected handshake.hello"))
            conn.close()
            return
        }
        val p = notif.params
        val projectId = p.get("projectId")?.asString
        val nonceSent = p.get("nonce")?.asString
        val tokenSent = p.get("token")?.asString
        val tokenOk = tokenSent != null && constantTimeEquals(tokenSent, token)
        val projectOk = projectId == ctx.projectId
        val nonceOk = nonceSent == nonce

        if (tokenOk && projectOk && nonceOk) {
            handshaken = true
            log("sidecar handshake ok")
            conn.send(
                RpcMessage.notification(
                    "agent.hello",
                    Json.obj(
                        "ok" to true,
                        "version" to VERSION,
                        "providerStatus" to emptyList<Any>(),
                    )
                )
            )
            ctx.onSidecarConnected(VERSION)
        } else {
            val reason = when {
                !tokenOk -> "invalid token"
                !projectOk -> "project id mismatch"
                else -> "invalid nonce"
            }
            conn.send(RpcMessage.responseError(null, 401, "handshake failed: $reason"))
            conn.close()
        }
    }

    private fun failAllPending(error: RpcError) {
        for (fut in pending.values) {
            fut.complete(SidecarReply(null, error))
        }
        pending.clear()
    }

    fun shutdown() {
        handshaken = false
        pool.shutdownNow()
        failAllPending(RpcError(503, "rpc server shutting down"))
        session?.let { s ->
            try {
                s.close()
            } catch (_: Exception) {
            }
        }
        session = null
        try {
            stop(1000)
        } catch (e: IOException) {
            log("rpc server stop error: ${e.message}")
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }

    private fun constantTimeEquals(a: String, b: String): Boolean {
        val aa = a.toByteArray()
        val bb = b.toByteArray()
        if (aa.size != bb.size) return false
        var diff = 0
        for (i in aa.indices) diff = diff or (aa[i].toInt() xor bb[i].toInt())
        return diff == 0
    }

    private fun log(msg: String) {
        ctx.audit.add("info", "rpc.server", msg, "ok")
    }
}
