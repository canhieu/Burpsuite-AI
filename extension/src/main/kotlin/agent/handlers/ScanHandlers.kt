package agent

import agent.rpc.Json
import agent.rpc.RpcFailure
import agent.http.RefItem
import burp.api.montoya.http.message.requests.HttpRequest
import burp.api.montoya.scanner.AuditConfiguration
import burp.api.montoya.scanner.BuiltInAuditConfiguration
import burp.api.montoya.scanner.CrawlConfiguration
import burp.api.montoya.scanner.ReportFormat
import burp.api.montoya.scanner.audit.AuditIssueHandler
import burp.api.montoya.scanner.audit.issues.AuditIssue
import burp.api.montoya.scanner.scancheck.ActiveScanCheck
import burp.api.montoya.scanner.scancheck.PassiveScanCheck
import burp.api.montoya.scanner.scancheck.ScanCheckType
import com.google.gson.JsonObject
import java.nio.file.Path

class ScanHandlers(private val ctx: AgentContext) : RpcHandler {

    override fun handles(method: String): Boolean =
        method.startsWith("scan.") || method == "bchecks.register" || method == "scan.check.register"

    override fun handle(method: String, params: JsonObject): Any? = when (method) {
        "scan.crawl" -> crawl(params)
        "scan.audit" -> audit(params)
        "scan.add_requests" -> addRequests(params)
        "scan.task_status" -> taskStatus(params)
        "scan.stop" -> stop(params)
        "scan.report" -> report(params)
        "bchecks.register" -> bchecksRegister(params)
        "scan.check.register" -> scanCheckRegister(params)
        else -> throw RpcFailure(-32601, "method not found: $method")
    }

    private fun crawl(params: JsonObject): JsonObject {
        val url = params.get("url")?.asString ?: throw RpcFailure(-32602, "url required")
        val config = CrawlConfiguration.crawlConfiguration(url)
        val crawl = ctx.api.scanner().startCrawl(config)
        val taskId = ctx.scanRegistry.putCrawl(crawl, listOf(url))
        ctx.logRpc("scan.crawl", url, "ok")
        return Json.obj("taskId" to taskId)
    }

    private fun audit(params: JsonObject): JsonObject {
        val urls = params.get("urls")?.takeIf { it.isJsonArray }?.asJsonArray
            ?.mapNotNull { it.takeIf { e -> e.isJsonPrimitive }?.asString }
            ?: throw RpcFailure(-32602, "urls required")
        if (urls.isEmpty()) throw RpcFailure(-32602, "urls empty")
        val auditConfig = AuditConfiguration.auditConfiguration(BuiltInAuditConfiguration.LEGACY_ACTIVE_AUDIT_CHECKS)
        val audit = ctx.api.scanner().startAudit(auditConfig)
        for (url in urls) {
            val request = HttpRequest.httpRequestFromUrl(url)
            audit.addRequest(request)
        }
        val taskId = ctx.scanRegistry.putAudit(audit, urls)
        ctx.logRpc("scan.audit", urls.first(), "ok")
        return Json.obj("taskId" to taskId)
    }

    private fun addRequests(params: JsonObject): JsonObject {
        val taskId = params.get("taskId")?.asString ?: throw RpcFailure(-32602, "taskId required")
        val task = ctx.scanRegistry.get(taskId) as? ScanTaskRegistry.Task.AuditTask
            ?: throw RpcFailure(404, "audit task not found: $taskId")
        val refs = params.get("refs")?.takeIf { it.isJsonArray }?.asJsonArray
            ?: throw RpcFailure(-32602, "refs required")
        var added = 0
        for (el in refs) {
            val ref = el.asJsonObject
            val item = ctx.fetchByRef(ref) ?: continue
            task.audit.addRequest(item.request)
            added++
        }
        ctx.logRpc("scan.add_requests", taskId, "ok", "added=$added")
        return Json.obj("ok" to true, "added" to added)
    }

    private fun taskStatus(params: JsonObject): JsonObject {
        val taskId = params.get("taskId")?.asString ?: throw RpcFailure(-32602, "taskId required")
        val task = ctx.scanRegistry.get(taskId) ?: throw RpcFailure(404, "task not found: $taskId")
        return when (task) {
            is ScanTaskRegistry.Task.CrawlTask -> Json.obj(
                "taskId" to taskId,
                "requests" to task.crawl.requestCount(),
                "errors" to task.crawl.errorCount(),
                "issues" to 0,
                "status" to (runCatching { task.crawl.statusMessage() }.getOrNull() ?: "running"),
            )
            is ScanTaskRegistry.Task.AuditTask -> Json.obj(
                "taskId" to taskId,
                "requests" to task.audit.requestCount(),
                "errors" to task.audit.errorCount(),
                "issues" to task.audit.issues().size,
                "status" to (runCatching { task.audit.statusMessage() }.getOrNull() ?: "running"),
            )
        }
    }

    private fun stop(params: JsonObject): JsonObject {
        val taskId = params.get("taskId")?.asString ?: throw RpcFailure(-32602, "taskId required")
        val task = ctx.scanRegistry.get(taskId) ?: throw RpcFailure(404, "task not found: $taskId")
        when (task) {
            is ScanTaskRegistry.Task.CrawlTask -> task.crawl.delete()
            is ScanTaskRegistry.Task.AuditTask -> task.audit.delete()
        }
        ctx.scanRegistry.remove(taskId)
        ctx.logRpc("scan.stop", taskId, "ok")
        return Json.obj("ok" to true)
    }

    private fun report(params: JsonObject): JsonObject {
        ctx.requireApproval("scan.report", params)
        val pathStr = params.get("path")?.asString ?: throw RpcFailure(-32602, "path required")
        val formatStr = params.get("format")?.asString ?: "html"
        val format = if (formatStr.equals("xml", ignoreCase = true)) ReportFormat.XML else ReportFormat.HTML
        val issues = collectIssues(params)
        ctx.api.scanner().generateReport(issues, format, Path.of(pathStr))
        ctx.logRpc("scan.report", pathStr, "ok", "issues=${issues.size}")
        return Json.obj("ok" to true, "path" to pathStr, "issues" to issues.size)
    }

    private fun bchecksRegister(params: JsonObject): JsonObject {
        ctx.requireApproval("bchecks.register", params)
        val definition = params.get("definition")?.asString ?: throw RpcFailure(-32602, "definition required")
        val result = ctx.api.scanner().bChecks().importBCheck(definition)
        val checkId = params.get("name")?.asString ?: "bcheck-${result.status().name}"
        ctx.logRpc("bchecks.register", checkId, result.status().name)
        return Json.obj("checkId" to checkId, "status" to result.status().name, "errors" to result.importErrors())
    }

    private fun scanCheckRegister(params: JsonObject): JsonObject {
        ctx.requireApproval("scan.check.register", params)
        val kind = params.get("kind")?.asString ?: "passive"
        val name = params.get("name")?.asString ?: "agent-check"
        if (kind == "active") {
            ctx.api.scanner().registerActiveScanCheck(
                object : ActiveScanCheck {
                    override fun checkName(): String = name
                    override fun doCheck(
                        requestResponse: burp.api.montoya.http.message.HttpRequestResponse,
                        insertionPoint: burp.api.montoya.scanner.audit.insertionpoint.AuditInsertionPoint,
                        http: burp.api.montoya.http.Http,
                    ): burp.api.montoya.scanner.AuditResult =
                        burp.api.montoya.scanner.AuditResult.auditResult(emptyList<AuditIssue>())

                    override fun consolidateIssues(
                        newIssue: AuditIssue,
                        existingIssue: AuditIssue,
                    ): burp.api.montoya.scanner.ConsolidationAction =
                        burp.api.montoya.scanner.ConsolidationAction.KEEP_EXISTING
                },
                ScanCheckType.PER_REQUEST,
            )
        } else {
            ctx.api.scanner().registerPassiveScanCheck(
                object : PassiveScanCheck {
                    override fun checkName(): String = name
                    override fun doCheck(
                        requestResponse: burp.api.montoya.http.message.HttpRequestResponse,
                    ): burp.api.montoya.scanner.AuditResult =
                        burp.api.montoya.scanner.AuditResult.auditResult(emptyList<AuditIssue>())

                    override fun consolidateIssues(
                        newIssue: AuditIssue,
                        existingIssue: AuditIssue,
                    ): burp.api.montoya.scanner.ConsolidationAction =
                        burp.api.montoya.scanner.ConsolidationAction.KEEP_EXISTING
                },
                ScanCheckType.PER_REQUEST,
            )
        }
        ctx.logRpc("scan.check.register", name, "ok")
        return Json.obj("checkId" to name, "kind" to kind)
    }

    private fun collectIssues(params: JsonObject): List<AuditIssue> {
        val taskId = params.get("taskId")?.asString
        if (taskId != null) {
            val task = ctx.scanRegistry.get(taskId)
            if (task is ScanTaskRegistry.Task.AuditTask) return task.audit.issues()
        }
        val issueIds = params.get("issueIds")?.takeIf { it.isJsonArray }?.asJsonArray
        if (issueIds != null && issueIds.size() > 0) {
            val wanted = issueIds.mapNotNull { it.takeIf { e -> e.isJsonPrimitive }?.asString }.toSet()
            return ctx.globalIssues.filter { wanted.contains(it.name()) }
        }
        return ctx.globalIssues.toList()
    }

    private fun fetchByRef(ref: JsonObject): RefItem? = ctx.fetchByRef(ref)
}
