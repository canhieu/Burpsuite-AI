package agent

import java.io.File
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class SidecarManager(private val ctx: AgentContext) {

    private val processRef = AtomicReference<Process?>()
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "agent-sidecar").apply { isDaemon = true } }

    private val isWindows: Boolean = System.getProperty("os.name").lowercase().contains("win")

    fun start() {
        executor.execute {
            doStart()
        }
    }

    fun startAndWait(timeoutMs: Long = 20000): StartResult {
        return try {
            executor.submit<StartResult> { doStart() }.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: Exception) {
            StartResult.Failure("sidecar start failed: ${e.message}")
        }
    }

    private fun doStart(): StartResult {
        if (processRef.get()?.isAlive == true) {
            return StartResult.Failure("sidecar already running")
        }
        val command = resolveCommand()
        if (command == null) {
            val err = "could not locate sidecar launcher (searched sidecar/bin/burp-sidecar, node dist/index.js, tsx)"
            ctx.audit.add("error", "sidecar.spawn", err, "failed")
            ctx.tab?.showError(err)
            return StartResult.Failure(err)
        }

        val rpc = ctx.rpcServer ?: return StartResult.Failure("rpc server not ready")
        val bindDeadline = System.currentTimeMillis() + 10000
        while (System.currentTimeMillis() < bindDeadline && rpc.port == 0) {
            Thread.sleep(50)
        }
        if (rpc.port == 0) return StartResult.Failure("rpc server did not bind a port")
        val env = mutableMapOf(
            "BURP_AGENT_WS_HOST" to "127.0.0.1",
            "BURP_AGENT_WS_PORT" to rpc.port.toString(),
            "BURP_AGENT_WS_URL" to "ws://127.0.0.1:${rpc.port}",
            "BURP_AGENT_TOKEN" to rpc.token,
            "BURP_AGENT_NONCE" to rpc.nonce,
            "BURP_AGENT_PROJECT_ID" to ctx.projectId,
        )
        env.forEach { (k, v) -> System.getenv(k)?.let { if (k != "BURP_AGENT_TOKEN") env[k] = it } }

        val pb = ProcessBuilder(command)
        pb.environment().putAll(env)
        pb.directory(workspaceDir())
        pb.redirectErrorStream(true)
        val logFile = File(System.getProperty("java.io.tmpdir"), "burp-agent-sidecar.log")
        try {
            pb.redirectOutput(ProcessBuilder.Redirect.appendTo(logFile))
        } catch (e: Exception) {
        }

        try {
            val process = pb.start()
            processRef.set(process)
            ctx.audit.add("info", "sidecar.spawn", command.joinToString(" "), "ok")
        } catch (e: IOException) {
            val err = "failed to spawn sidecar: ${e.message}"
            ctx.audit.add("error", "sidecar.spawn", command.joinToString(" "), "failed", err)
            ctx.tab?.showError(err)
            return StartResult.Failure(err)
        }

        val deadline = System.currentTimeMillis() + 30000
        while (System.currentTimeMillis() < deadline) {
            if (ctx.connected) {
                ctx.audit.add("info", "sidecar.handshake", "connected", "ok")
                return StartResult.Success
            }
            if (processRef.get()?.isAlive == false) {
                val err = "sidecar process exited before handshake"
                ctx.audit.add("error", "sidecar.handshake", err, "failed")
                ctx.tab?.showError(err)
                return StartResult.Failure(err)
            }
            Thread.sleep(250)
        }
        val err = "timed out waiting for sidecar handshake"
        ctx.audit.add("error", "sidecar.handshake", err, "failed")
        ctx.tab?.showError(err)
        return StartResult.Failure(err)
    }

    fun stop() {
        val process = processRef.getAndSet(null)
        if (process != null && process.isAlive) {
            try {
                process.destroy()
                if (!process.waitFor(3, TimeUnit.SECONDS)) {
                    process.destroyForcibly()
                }
            } catch (e: Exception) {
            }
        }
    }

    fun isRunning(): Boolean = processRef.get()?.isAlive == true

    fun shutdown() {
        stop()
        executor.shutdownNow()
    }

    private fun workspaceDir(): File? {
        val repo = repoRoot() ?: return File(System.getProperty("user.dir"))
        return File(repo, "sidecar")
    }

    private fun repoRoot(): File? {
        val envRoot = System.getenv("BURP_AGENT_REPO")
        if (!envRoot.isNullOrBlank() && File(envRoot).isDirectory) return File(envRoot)
        val propRoot = System.getProperty("burp.agent.repo")
        if (!propRoot.isNullOrBlank() && File(propRoot).isDirectory) return File(propRoot)
        val cwd = File(System.getProperty("user.dir"))
        if (File(cwd, "sidecar").isDirectory) return cwd
        val parent = cwd.parentFile
        if (parent != null && File(parent, "sidecar").isDirectory) return parent
        return null
    }

    private fun resolveCommand(): List<String>? {
        val root = repoRoot() ?: return null
        val sidecarDir = File(root, "sidecar")
        if (!sidecarDir.isDirectory) return null

        val binDir = File(sidecarDir, "bin")
        val exeName = if (isWindows) "burp-sidecar.exe" else "burp-sidecar"
        val bundled = File(binDir, exeName)
        if (bundled.isFile) return listOf(bundled.absolutePath)

        val dist = File(sidecarDir, "dist" + File.separator + "index.js")
        if (dist.isFile) return listOf("node", dist.absolutePath)

        val nodeModulesBin = File(sidecarDir, "node_modules" + File.separator + ".bin")
        val tsxBin = if (isWindows) File(nodeModulesBin, "tsx.cmd") else File(nodeModulesBin, "tsx")
        if (tsxBin.exists()) {
            return listOf("node", "--import", "tsx", File(sidecarDir, "src" + File.separator + "index.ts").absolutePath)
        }
        return null
    }

    sealed class StartResult {
        data object Success : StartResult()
        data class Failure(val reason: String) : StartResult()
    }
}
