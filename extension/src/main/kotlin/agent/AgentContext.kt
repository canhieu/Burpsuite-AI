package agent

import agent.http.RawHttpMessage
import agent.http.RefItem
import agent.rpc.Json
import agent.rpc.RpcFailure
import burp.api.montoya.MontoyaApi
import burp.api.montoya.collaborator.CollaboratorClient
import burp.api.montoya.http.message.HttpRequestResponse
import burp.api.montoya.http.message.requests.HttpRequest
import burp.api.montoya.http.message.responses.HttpResponse
import burp.api.montoya.scanner.Crawl
import burp.api.montoya.scanner.audit.Audit
import burp.api.montoya.scanner.audit.issues.AuditIssue
import burp.api.montoya.websocket.extension.ExtensionWebSocket
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import java.time.Instant
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

class AgentContext(val api: MontoyaApi) {

    val projectId: String
        get() = api.project().id()

    val policy = Policy(
        isInScope = { url ->
            try {
                api.scope().isInScope(url)
            } catch (e: Exception) {
                false
            }
        }
    )

    val audit = AuditLog()
    val messageStore = MessageStore()
    val selection = SelectionStore()
    val authContexts = AuthContextStore()
    val wsRegistry = WebSocketRegistry()
    val scanRegistry = ScanTaskRegistry()
    val collaboratorRegistry = CollaboratorRegistry()
    val idempotency = IdempotencyCache()
    val approvalBroker = ApprovalBroker(
        isConnected = { rpcServer?.isConnected() == true },
        sendNotification = { m, p -> rpcServer?.sendNotification(m, p) }
    )
    val globalIssues = CopyOnWriteArrayList<AuditIssue>()

    @Volatile var connected: Boolean = false
        private set
    @Volatile var sidecarVersion: String = ""

    var rpcServer: RpcServer? = null
        internal set
    var sidecar: SidecarManager? = null
        internal set
    var tab: AgentTab? = null
        internal set
    var handlers: Handlers? = null
        internal set

    fun onSidecarConnected(version: String) {
        connected = true
        sidecarVersion = version
        audit.add("info", "sidecar.connected", version, "ok")
        tab?.onSidecarConnected(version)
    }

    fun onSidecarDisconnected() {
        connected = false
        audit.add("warn", "sidecar.disconnected", "", "ok")
        tab?.onSidecarDisconnected()
    }

    fun onSidecarEvent(method: String, params: JsonObject) {
        tab?.onSidecarEvent(method, params)
    }

    fun logRpc(method: String, target: String, status: String, note: String = "") {
        audit.add("rpc", method, target, status, note)
    }

    fun fetchByRef(ref: JsonObject): RefItem? {
        val source = ref.get("source")?.asString ?: ""
        val idEl = ref.get("id") ?: return null
        val idNum = idEl.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asLong
        return when (source) {
            "proxy" -> idNum?.let { n ->
                api.proxy().history().firstOrNull { it.id().toLong() == n }?.let { RefItem.fromProxy(it) }
            }
            "agent" -> idNum?.let { messageStore.get(it) }?.let { RefItem.fromHttpRequestResponse(it) }
            "siteMap" -> {
                val url = idEl.asString
                api.siteMap().requestResponses().firstOrNull { it.url() == url }?.let { RefItem.fromHttpRequestResponse(it) }
            }
            else -> null
        }
    }

    fun requireApproval(method: String, params: JsonObject, target: String? = null, risk: String = "medium") {
        if (policy.requiresApproval(method)) {
            val result = approvalBroker.request(method, params, target, risk)
            if (result !is ApprovalResult.Approved) {
                throw RpcFailure(
                    403,
                    "approval required and not granted for $method",
                    Json.obj("reason" to "approval not granted")
                )
            }
        }
    }
}

data class AuditEntry(
    val time: Long,
    val level: String,
    val method: String,
    val target: String,
    val status: String,
    val note: String = "",
) {
    val timeIso: String get() = Instant.ofEpochMilli(time).toString()
}

class AuditLog(val capacity: Int = 2000) {
    private val entries = ArrayDeque<AuditEntry>()
    private val lock = Any()

    @Volatile
    var listener: ((AuditEntry) -> Unit)? = null

    fun add(level: String, method: String, target: String, status: String = "ok", note: String = ""): AuditEntry {
        val e = AuditEntry(System.currentTimeMillis(), level, method, target, status, note)
        synchronized(lock) {
            entries.addLast(e)
            while (entries.size > capacity) entries.removeFirst()
        }
        listener?.let { runCatching { it(e) } }
        return e
    }

    fun recent(since: Long? = null, host: String? = null): List<AuditEntry> = synchronized(lock) {
        entries.filter { e ->
            (since == null || e.time >= since) && (host == null || e.target.contains(host, ignoreCase = true))
        }.toList()
    }

    fun all(): List<AuditEntry> = synchronized(lock) { entries.toList() }
}

class MessageStore {
    private val map = ConcurrentHashMap<Long, HttpRequestResponse>()
    private val seq = AtomicLong(1)

    fun put(rr: HttpRequestResponse): Long {
        val id = seq.getAndIncrement()
        map[id] = rr
        return id
    }

    fun get(id: Long): HttpRequestResponse? = map[id]
    fun request(id: Long): HttpRequest? = map[id]?.request()
    fun response(id: Long): HttpResponse? = map[id]?.response()
}

class SelectionStore {
    data class Selection(
        val requestResponse: HttpRequestResponse,
        val refId: Long,
        val source: String,
        val invocationType: String?,
        val at: Long,
    )

    private val last = AtomicReference<Selection?>()
    private val seq = AtomicLong(1)

    fun store(rr: HttpRequestResponse, invocationType: String? = null, source: String = "agent") {
        last.set(Selection(rr, seq.getAndIncrement(), source, invocationType, System.currentTimeMillis()))
    }

    fun latest(): Selection? = last.get()
    fun clear() = last.set(null)
}

class AuthContextStore {
    private val active = AtomicReference("anon")
    private val headers = ConcurrentHashMap<String, MutableMap<String, String>>()

    fun setActive(context: String) {
        active.set(context)
    }

    fun active(): String = active.get()

    fun setHeader(context: String, name: String, value: String) {
        headers.computeIfAbsent(context) { ConcurrentHashMap() }[name] = value
    }

    fun headersFor(context: String): Map<String, String> =
        headers[context]?.toMap() ?: emptyMap()

    fun applyTo(msg: RawHttpMessage, context: String): RawHttpMessage {
        var out = msg
        for ((name, value) in headersFor(context)) {
            out = out.withHeader(name, value)
        }
        return out
    }
}

class WebSocketRegistry {
    data class WsEntry(
        val id: String,
        val ws: ExtensionWebSocket,
        val upgradeRequest: HttpRequest,
        val created: Long,
        val messages: CopyOnWriteArrayList<Pair<Direction, String>>,
    )

    enum class Direction { SENT, RECEIVED }

    private val map = ConcurrentHashMap<String, WsEntry>()
    private val seq = AtomicLong(1)

    fun register(ws: ExtensionWebSocket, upgradeRequest: HttpRequest): String {
        val id = "ws-${seq.getAndIncrement()}"
        map[id] = WsEntry(id, ws, upgradeRequest, System.currentTimeMillis(), CopyOnWriteArrayList())
        return id
    }

    fun get(id: String): WsEntry? = map[id]
    fun remove(id: String) {
        map.remove(id)
    }

    fun list(): List<WsEntry> = map.values.toList()
}

class ScanTaskRegistry {
    sealed class Task(val taskId: String) {
        class CrawlTask(taskId: String, val crawl: Crawl, val seeds: List<String>) : Task(taskId)
        class AuditTask(taskId: String, val audit: Audit, val seeds: List<String>) : Task(taskId)
    }

    private val map = ConcurrentHashMap<String, Task>()
    private val seq = AtomicLong(1)

    fun putCrawl(crawl: Crawl, seeds: List<String>): String {
        val id = "crawl-${seq.getAndIncrement()}"
        map[id] = Task.CrawlTask(id, crawl, seeds)
        return id
    }

    fun putAudit(audit: Audit, seeds: List<String>): String {
        val id = "audit-${seq.getAndIncrement()}"
        map[id] = Task.AuditTask(id, audit, seeds)
        return id
    }

    fun get(id: String): Task? = map[id]
    fun remove(id: String) {
        map.remove(id)
    }
}

class CollaboratorRegistry {
    private val clients = ConcurrentHashMap<String, CollaboratorClient>()

    fun put(key: String, client: CollaboratorClient) {
        clients[key] = client
    }

    fun get(key: String): CollaboratorClient? = clients[key]
    fun remove(key: String) = clients.remove(key)
    fun list(): List<Pair<String, CollaboratorClient>> = clients.entries.map { it.key to it.value }
}

class IdempotencyCache(val max: Int = 256) {
    private val map = object : LinkedHashMap<String, JsonElement>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, JsonElement>?): Boolean = size > max
    }
    private val lock = Any()

    fun get(key: String): JsonElement? = synchronized(lock) { map[key] }
    fun put(key: String, value: JsonElement) = synchronized(lock) { map[key] = value }
}

sealed class ApprovalResult {
    data object Approved : ApprovalResult()
    data class Denied(val reason: String) : ApprovalResult()
}

class ApprovalBroker(
    private val isConnected: () -> Boolean,
    private val sendNotification: (String, JsonObject) -> Unit,
) {
    private val pending = ConcurrentHashMap<String, java.util.concurrent.CompletableFuture<Boolean>>()

    fun request(method: String, params: JsonObject, target: String?, risk: String, timeoutSec: Long = 30): ApprovalResult {
        if (!isConnected()) return ApprovalResult.Denied("no sidecar connected")
        val requestId = UUID.randomUUID().toString()
        val request = Json.obj(
            "id" to requestId,
            "runId" to "extension",
            "reason" to "approval required for $method",
            "toolCall" to Json.obj("name" to method, "arguments" to params),
            "target" to target,
            "risk" to risk,
        )
        val fut = java.util.concurrent.CompletableFuture<Boolean>()
        pending[requestId] = fut
        try {
            sendNotification("approval.requested", Json.obj("runId" to "extension", "request" to request))
            return try {
                if (fut.get(timeoutSec, TimeUnit.SECONDS)) ApprovalResult.Approved
                else ApprovalResult.Denied("rejected")
            } catch (e: Exception) {
                ApprovalResult.Denied("approval timeout")
            }
        } finally {
            pending.remove(requestId)
        }
    }

    fun resolve(requestId: String, approved: Boolean) {
        pending.remove(requestId)?.complete(approved)
    }
}

object Base64Util {
    fun encode(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
    fun encode(s: String): String = Base64.getEncoder().encodeToString(s.toByteArray())
    fun decode(s: String): ByteArray = Base64.getDecoder().decode(s)
}
