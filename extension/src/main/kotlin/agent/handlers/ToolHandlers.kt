package agent

import agent.http.HttpBridge
import agent.http.HttpJson
import agent.http.RefItem
import agent.rpc.Json
import agent.rpc.RpcFailure
import burp.api.montoya.burpsuite.TaskExecutionEngine
import burp.api.montoya.core.ByteArray
import burp.api.montoya.collaborator.SecretKey
import burp.api.montoya.http.message.requests.HttpRequest
import burp.api.montoya.intruder.HttpRequestTemplate
import burp.api.montoya.intruder.HttpRequestTemplateGenerationOptions
import burp.api.montoya.websocket.TextMessage
import burp.api.montoya.websocket.extension.ExtensionWebSocketMessageHandler
import com.google.gson.JsonObject
import com.google.gson.JsonParser

class ToolHandlers(private val ctx: AgentContext) : RpcHandler {

    override fun handles(method: String): Boolean = method.startsWith("tool.") ||
        method.startsWith("site_map.") ||
        method.startsWith("scope.") ||
        method.startsWith("proxy.") ||
        method.startsWith("config.") ||
        method.startsWith("task_engine.") ||
        method.startsWith("oob.") ||
        method.startsWith("websocket.") ||
        method == "auth.switch_context" ||
        method == "policy.set_mode" ||
        method == "policy.status"

    override fun handle(method: String, params: JsonObject): Any? = when (method) {
        "tool.repeater.send" -> repeaterSend(params)
        "tool.intruder.send" -> intruderSend(params)
        "tool.comparer.send" -> comparerSend(params)
        "tool.organizer.send" -> organizerSend(params)
        "tool.organizer.read" -> organizerRead(params)
        "site_map.list" -> siteMapList(params)
        "site_map.add" -> siteMapAdd(params)
        "site_map.issues" -> siteMapIssues(params)
        "scope.get" -> scopeGet(params)
        "scope.add" -> scopeAdd(params)
        "scope.remove" -> scopeRemove(params)
        "proxy.set_intercept" -> proxySetIntercept(params)
        "config.export" -> configExport(params)
        "config.import" -> configImport(params)
        "task_engine.pause" -> taskEnginePause(params)
        "task_engine.resume" -> taskEngineResume(params)
        "oob.session" -> oobSession(params)
        "oob.poll" -> oobPoll(params)
        "websocket.create" -> webSocketCreate(params)
        "websocket.send" -> webSocketSend(params)
        "websocket.close" -> webSocketClose(params)
        "auth.switch_context" -> authSwitchContext(params)
        "policy.set_mode" -> policySetMode(params)
        "policy.status" -> policyStatus(params)
        else -> throw RpcFailure(-32601, "method not found: $method")
    }

    private fun policySetMode(params: JsonObject): JsonObject {
        val mode = params.get("mode")?.asString ?: throw RpcFailure(-32602, "mode required")
        if (mode !in setOf("manual", "autonomous")) {
            throw RpcFailure(-32602, "mode must be manual or autonomous")
        }
        ctx.policy.mode = mode
        ctx.logRpc("policy.set_mode", mode, "ok")
        return Json.obj("mode" to mode)
    }

    private fun policyStatus(params: JsonObject): JsonObject {
        return Json.obj(
            "mode" to ctx.policy.mode,
            "requestsUsed" to ctx.policy.requestsUsed(),
            "killSwitch" to ctx.policy.killAll.get(),
            "requestCap" to ctx.policy.budgetConfig.requestCap,
        )
    }

    private fun repeaterSend(params: JsonObject): JsonObject {
        val request = buildRequest(params) ?: throw RpcFailure(-32602, "request or ref required")
        val name = params.get("name")?.asString
        if (name != null) ctx.api.repeater().sendToRepeater(request, name)
        else ctx.api.repeater().sendToRepeater(request)
        ctx.logRpc("tool.repeater.send", request.url(), "ok")
        return Json.obj("ok" to true)
    }

    private fun intruderSend(params: JsonObject): JsonObject {
        val request = buildRequest(params) ?: throw RpcFailure(-32602, "request or ref required")
        val name = params.get("name")?.asString
        val positions = params.get("template")?.takeIf { it.isJsonObject }?.asJsonObject?.get("positions")
        if (positions != null && positions.isJsonArray && positions.asJsonArray.size() > 0) {
            val template = HttpRequestTemplate.httpRequestTemplate(
                request,
                HttpRequestTemplateGenerationOptions.APPEND_OFFSETS_TO_BASE_PARAMETER_VALUE
            )
            val service = request.httpService()
            if (name != null && service != null) {
                ctx.api.intruder().sendToIntruder(service, template, name)
            } else if (service != null) {
                ctx.api.intruder().sendToIntruder(service, template)
            } else {
                throw RpcFailure(-32602, "cannot determine http service")
            }
        } else {
            if (name != null) ctx.api.intruder().sendToIntruder(request, name)
            else ctx.api.intruder().sendToIntruder(request)
        }
        ctx.logRpc("tool.intruder.send", request.url(), "ok")
        return Json.obj("ok" to true)
    }

    private fun comparerSend(params: JsonObject): JsonObject {
        val items = params.get("items")?.takeIf { it.isJsonArray }?.asJsonArray
            ?: throw RpcFailure(-32602, "items required")
        val bytes = ArrayList<ByteArray>()
        for (el in items) {
            val item = el.asJsonObject
            bytes.add(rawOfItem(item))
        }
        ctx.api.comparer().sendToComparer(*bytes.toTypedArray())
        ctx.logRpc("tool.comparer.send", "${bytes.size} items", "ok")
        return Json.obj("ok" to true)
    }

    private fun organizerSend(params: JsonObject): JsonObject {
        val request = buildRequest(params) ?: throw RpcFailure(-32602, "request or ref required")
        val responseParam = params.get("response")?.takeIf { it.isJsonObject }?.asJsonObject
        if (responseParam != null) {
            val respRaw = HttpJson.fromJson(responseParam)
            val response = burp.api.montoya.http.message.responses.HttpResponse.httpResponse(ByteArray.byteArray(*respRaw.toBytes()))
            val rr = HttpBridge.requestResponse(request, response)
            ctx.api.organizer().sendToOrganizer(rr)
        } else {
            ctx.api.organizer().sendToOrganizer(request)
        }
        ctx.logRpc("tool.organizer.send", request.url(), "ok")
        return Json.obj("ok" to true)
    }

    private fun organizerRead(params: JsonObject): JsonObject {
        val items = ctx.api.organizer().items().map { it ->
            Json.obj("id" to it.id(), "status" to it.status().name)
        }
        return Json.obj("items" to items)
    }

    private fun siteMapList(params: JsonObject): JsonObject {
        val host = params.get("host")?.asString?.lowercase()
        val filter = params.get("filter")?.asString
        val items = ctx.api.siteMap().requestResponses().mapNotNull { rr ->
            val url = rr.url()
            if (host != null && !url.contains(host, ignoreCase = true)) return@mapNotNull null
            if (filter != null && !url.contains(filter, ignoreCase = true)) return@mapNotNull null
            Json.obj(
                "url" to url,
                "method" to rr.request().method(),
                "status" to rr.response()?.statusCode(),
                "mime" to rr.response()?.mimeType()?.name,
            )
        }.take(1000)
        return Json.obj("items" to items)
    }

    private fun siteMapAdd(params: JsonObject): JsonObject {
        ctx.requireApproval("site_map.add", params)
        val request = buildRequest(params) ?: throw RpcFailure(-32602, "request or ref required")
        val responseParam = params.get("response")?.takeIf { it.isJsonObject }?.asJsonObject
        val rr = if (responseParam != null) {
            val respRaw = HttpJson.fromJson(responseParam)
            val response = burp.api.montoya.http.message.responses.HttpResponse.httpResponse(ByteArray.byteArray(*respRaw.toBytes()))
            HttpBridge.requestResponse(request, response)
        } else {
            HttpBridge.requestResponse(request, null)
        }
        ctx.api.siteMap().add(rr)
        ctx.logRpc("site_map.add", request.url(), "ok")
        return Json.obj("ok" to true)
    }

    private fun siteMapIssues(params: JsonObject): JsonObject {
        val issues = ctx.api.siteMap().issues().map { issue ->
            Json.obj(
                "name" to issue.name(),
                "severity" to issue.severity().name,
                "confidence" to issue.confidence().name,
                "url" to issue.baseUrl(),
                "detail" to issue.detail(),
            )
        }
        return Json.obj("issues" to issues)
    }

    private fun scopeGet(params: JsonObject): JsonObject {
        val include = ArrayList<String>()
        val exclude = ArrayList<String>()
        try {
            val json = ctx.api.burpSuite().exportProjectOptionsAsJson()
            val root = JsonParser.parseString(json)
            if (root.isJsonObject) {
                findScopeArrays(root.asJsonObject) { isInclude, url -> if (isInclude) include.add(url) else exclude.add(url) }
            }
        } catch (e: Exception) {
        }
        return Json.obj("scope" to include.toList(), "include" to include.toList(), "exclude" to exclude.toList())
    }

    private fun scopeAdd(params: JsonObject): JsonObject {
        ctx.requireApproval("scope.add", params)
        val urls = stringList(params, "urls")
        for (url in urls) ctx.api.scope().includeInScope(url)
        ctx.logRpc("scope.add", urls.joinToString(","), "ok")
        return Json.obj("ok" to true, "added" to urls.size)
    }

    private fun scopeRemove(params: JsonObject): JsonObject {
        ctx.requireApproval("scope.remove", params)
        val urls = stringList(params, "urls")
        for (url in urls) ctx.api.scope().excludeFromScope(url)
        ctx.logRpc("scope.remove", urls.joinToString(","), "ok")
        return Json.obj("ok" to true, "removed" to urls.size)
    }

    private fun proxySetIntercept(params: JsonObject): JsonObject {
        ctx.requireApproval("proxy.set_intercept", params)
        val enabled = params.get("enabled")?.asBoolean ?: throw RpcFailure(-32602, "enabled required")
        if (enabled) ctx.api.proxy().enableIntercept() else ctx.api.proxy().disableIntercept()
        ctx.logRpc("proxy.set_intercept", "enabled=$enabled", "ok")
        return Json.obj("ok" to true, "enabled" to ctx.api.proxy().isInterceptEnabled())
    }

    private fun configExport(params: JsonObject): JsonObject {
        val paths = params.get("paths")?.takeIf { it.isJsonArray }?.asJsonArray
            ?.mapNotNull { it.takeIf { v -> v.isJsonPrimitive }?.asString }?.toTypedArray()
            ?: emptyArray()
        val json = ctx.api.burpSuite().exportProjectOptionsAsJson(*paths)
        return Json.obj("json" to json)
    }

    private fun configImport(params: JsonObject): JsonObject {
        ctx.requireApproval("config.import", params)
        val json = params.get("json")?.asString ?: throw RpcFailure(-32602, "json required")
        ctx.api.burpSuite().importProjectOptionsFromJson(json)
        ctx.logRpc("config.import", "", "ok")
        return Json.obj("ok" to true)
    }

    private fun taskEnginePause(params: JsonObject): JsonObject {
        ctx.requireApproval("task_engine.pause", params)
        ctx.api.burpSuite().taskExecutionEngine().setState(TaskExecutionEngine.TaskExecutionEngineState.PAUSED)
        return Json.obj("ok" to true, "state" to "PAUSED")
    }

    private fun taskEngineResume(params: JsonObject): JsonObject {
        ctx.requireApproval("task_engine.resume", params)
        ctx.api.burpSuite().taskExecutionEngine().setState(TaskExecutionEngine.TaskExecutionEngineState.RUNNING)
        return Json.obj("ok" to true, "state" to "RUNNING")
    }

    private fun oobSession(params: JsonObject): JsonObject {
        val client = ctx.api.collaborator().createClient()
        val secretKey = client.getSecretKey().toString()
        ctx.collaboratorRegistry.put(secretKey, client)
        val dns = client.generatePayload().toString()
        val http = "http://$dns/"
        val https = "https://$dns/"
        return Json.obj(
            "clientId" to secretKey,
            "secretKey" to secretKey,
            "payloads" to Json.obj("dns" to dns, "http" to http, "https" to https),
            "pollToken" to Base64Util.encode(secretKey),
        )
    }

    private fun oobPoll(params: JsonObject): JsonObject {
        val clientId = params.get("clientId")?.asString ?: throw RpcFailure(-32602, "clientId required")
        val client = ctx.collaboratorRegistry.get(clientId)
            ?: runCatching { ctx.api.collaborator().restoreClient(SecretKey.secretKey(clientId)) }.getOrNull()
            ?: throw RpcFailure(404, "collaborator client not found")
        val interactions = client.getAllInteractions().map { it ->
            val http = it.httpDetails().orElse(null)
            val dns = it.dnsDetails().orElse(null)
            Json.obj(
                "type" to it.type().name,
                "protocol" to http?.protocol()?.name,
                "ip" to it.clientIp().hostAddress,
                "time" to it.timeStamp().toInstant().toEpochMilli(),
                "data" to Json.obj(
                    "queryType" to dns?.queryType()?.name,
                    "query" to dns?.query()?.toString(),
                    "httpProtocol" to http?.protocol()?.name,
                    "request" to http?.requestResponse()?.request()?.toString(),
                    "response" to http?.requestResponse()?.response()?.toString(),
                ),
            )
        }
        return Json.obj("interactions" to interactions)
    }

    private fun webSocketCreate(params: JsonObject): JsonObject {
        val upgradeRef = params.get("upgradeRef")?.takeIf { it.isJsonObject }?.asJsonObject
        val reqJson = params.get("request")?.takeIf { it.isJsonObject }?.asJsonObject
        val request: HttpRequest = when {
            upgradeRef != null -> {
                val base = ctx.fetchByRef(upgradeRef) ?: throw RpcFailure(404, "upgrade request not found")
                base.request
            }
            reqJson != null -> buildRequest(params) ?: throw RpcFailure(-32602, "cannot build request")
            else -> throw RpcFailure(-32602, "upgradeRef or request required")
        }
        val creation = ctx.api.websockets().createWebSocket(request)
        val status = creation.status()
        if (status == burp.api.montoya.websocket.extension.ExtensionWebSocketCreationStatus.SUCCESS) {
            val ws = creation.webSocket().orElse(null) ?: throw RpcFailure(500, "websocket creation returned no socket")
            val wsId = ctx.wsRegistry.register(ws, request)
            ws.registerMessageHandler(object : ExtensionWebSocketMessageHandler {
                override fun textMessageReceived(message: TextMessage) {
                    val id = wsId
                    ctx.wsRegistry.get(id)?.messages?.add(WebSocketRegistry.Direction.RECEIVED to message.payload())
                    ctx.onSidecarEvent("websocket.message", Json.obj("wsId" to id, "direction" to "in", "text" to message.payload()))
                }

                override fun binaryMessageReceived(message: burp.api.montoya.websocket.BinaryMessage) {
                    val id = wsId
                    val b64 = Base64Util.encode(message.payload().getBytes())
                    ctx.wsRegistry.get(id)?.messages?.add(WebSocketRegistry.Direction.RECEIVED to "base64:$b64")
                    ctx.onSidecarEvent("websocket.message", Json.obj("wsId" to id, "direction" to "in", "base64" to b64))
                }

                override fun onClose() {
                    ctx.wsRegistry.remove(wsId)
                }
            })
            ctx.logRpc("websocket.create", request.url(), status.name)
            return Json.obj("wsId" to wsId, "status" to status.name)
        }
        throw RpcFailure(500, "websocket create failed: ${status.name}")
    }

    private fun webSocketSend(params: JsonObject): JsonObject {
        val wsId = params.get("wsId")?.asString ?: throw RpcFailure(-32602, "wsId required")
        val entry = ctx.wsRegistry.get(wsId) ?: throw RpcFailure(404, "websocket not found: $wsId")
        val payloadEl = params.get("payload") ?: throw RpcFailure(-32602, "payload required")
        val opcode = params.get("opcode")?.asInt ?: 1
        if (payloadEl.isJsonPrimitive && payloadEl.asJsonPrimitive.isString) {
            if (opcode == 2) {
                entry.ws.sendBinaryMessage(ByteArray.byteArray(*Base64Util.decode(payloadEl.asString)))
            } else {
                entry.ws.sendTextMessage(payloadEl.asString)
            }
        } else if (payloadEl.isJsonObject) {
            val obj = payloadEl.asJsonObject
            val text = obj.get("text")?.asString
            val binary = obj.get("binary")?.asString
            if (binary != null) entry.ws.sendBinaryMessage(ByteArray.byteArray(*Base64Util.decode(binary)))
            else if (text != null) entry.ws.sendTextMessage(text)
            else throw RpcFailure(-32602, "payload object must have text or binary")
        } else {
            throw RpcFailure(-32602, "payload must be string or object")
        }
        entry.messages.add(WebSocketRegistry.Direction.SENT to payloadEl.toString())
        return Json.obj("result" to "sent")
    }

    private fun webSocketClose(params: JsonObject): JsonObject {
        val wsId = params.get("wsId")?.asString ?: throw RpcFailure(-32602, "wsId required")
        val entry = ctx.wsRegistry.get(wsId) ?: throw RpcFailure(404, "websocket not found: $wsId")
        entry.ws.close()
        ctx.wsRegistry.remove(wsId)
        return Json.obj("result" to "closed")
    }

    private fun authSwitchContext(params: JsonObject): JsonObject {
        val context = params.get("context")?.asString ?: throw RpcFailure(-32602, "context required")
        if (context !in setOf("accountA", "accountB", "anon")) {
            throw RpcFailure(-32602, "context must be accountA, accountB or anon")
        }
        ctx.authContexts.setActive(context)
        ctx.logRpc("auth.switch_context", context, "ok")
        return Json.obj("active" to context)
    }

    private fun buildRequest(params: JsonObject): HttpRequest? {
        val ref = params.get("ref")?.takeIf { it.isJsonObject }?.asJsonObject
        if (ref != null) {
            val base = ctx.fetchByRef(ref) ?: return null
            return base.request
        }
        val reqJson = params.get("request")?.takeIf { it.isJsonObject }?.asJsonObject ?: return null
        val raw = HttpJson.fromJson(reqJson)
        val service = HttpBridge.serviceFor(raw, null)
        return HttpBridge.request(raw, service)
    }

    private fun rawOfItem(item: JsonObject): ByteArray {
        val ref = item.get("ref")?.takeIf { it.isJsonObject }?.asJsonObject
        if (ref != null) {
            val base = ctx.fetchByRef(ref)
            if (base != null) return base.request.toByteArray()
        }
        val raw = HttpJson.fromJson(item)
        return ByteArray.byteArray(*raw.toBytes())
    }

    private fun fetchByRef(ref: JsonObject): RefItem? = ctx.fetchByRef(ref)

    private fun stringList(params: JsonObject, key: String): List<String> {
        val arr = params.get(key)?.takeIf { it.isJsonArray }?.asJsonArray
            ?: throw RpcFailure(-32602, "$key required")
        return arr.map { it.asString }
    }

    private fun findScopeArrays(root: JsonObject, sink: (Boolean, String) -> Unit) {
        fun walk(el: com.google.gson.JsonElement) {
            when {
                el.isJsonObject -> {
                    val o = el.asJsonObject
                    val include = o.get("include")
                    val exclude = o.get("exclude")
                    if (include?.isJsonArray == true && exclude?.isJsonArray == true) {
                        val includeItems = include.asJsonArray
                        if (includeItems.size() > 0 && includeItems.first().isJsonObject && includeItems.first().asJsonObject.has("host")) {
                            for (e in includeItems) scopeUrl(e.asJsonObject)?.let { sink(true, it) }
                            for (e in exclude.asJsonArray) scopeUrl(e.asJsonObject)?.let { sink(false, it) }
                            return
                        }
                    }
                    for ((_, v) in o.entrySet()) walk(v)
                }
                el.isJsonArray -> {
                    for (e in el.asJsonArray) walk(e)
                }
            }
        }
        walk(root)
    }

    private fun scopeUrl(item: JsonObject): String? {
        val host = item.get("host")?.asString ?: return null
        val protocol = item.get("protocol")?.asString ?: "http"
        val port = item.get("port")?.asInt
        val file = item.get("file")?.asString ?: ""
        val portPart = if (port != null && port != 80 && port != 443) ":$port" else ""
        return "$protocol://$host$portPart$file"
    }
}
