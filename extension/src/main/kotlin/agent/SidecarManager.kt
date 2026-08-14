package agent

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Paths
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
            val err = "could not locate sidecar launcher\n" +
                "searched (in order):\n" +
                "  - config file ~/.burp-agent/sidecar.json -> sidecarDir\n" +
                "  - env BURP_AGENT_SIDECAR_DIR\n" +
                "  - sysprop burp.agent.sidecarDir\n" +
                "  - dir of the extension jar\n" +
                "  - cwd / cwd-parent / user.home for a 'sidecar' folder\n" +
                "looked for: bin/burp-sidecar(.exe), dist/index.js, src/index.ts (tsx)\n\n" +
                "Fix: create ~/.burp-agent/sidecar.json with {\"sidecarDir\": \"E:/lab/burp/sidecar\"} " +
                "or set env BURP_AGENT_SIDECAR_DIR."
            ctx.audit.add("error", "sidecar.spawn", "could not locate sidecar launcher", "failed")
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
                val err = "sidecar process exited before handshake (see $logFile)"
                ctx.audit.add("error", "sidecar.handshake", err, "failed")
                ctx.tab?.showError(err)
                return StartResult.Failure(err)
            }
            Thread.sleep(250)
        }
        val err = "timed out waiting for sidecar handshake (see $logFile)"
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
        val root = repoRoot()
        val explicit = explicitSidecarDir()
        if (explicit != null) return File(explicit)
        if (root != null) {
            val s = File(root, "sidecar")
            if (s.isDirectory) return s
        }
        return File(System.getProperty("user.dir"))
    }

    /** Priority: config file -> env -> sysprop. Returns absolute sidecar dir or null. */
    private fun explicitSidecarDir(): String? {
        // 1. config file ~/.burp-agent/sidecar.json { "sidecarDir": "..." }
        try {
            val home = System.getProperty("user.home")
            if (home != null) {
                val cfgFile = File(File(home, ".burp-agent"), "sidecar.json")
                if (cfgFile.isFile) {
                    val text = cfgFile.readText()
                    val idx = text.indexOf("\"sidecarDir\"")
                    if (idx >= 0) {
                        val rest = text.substring(idx + 13)
                        val start = rest.indexOf('"')
                        if (start >= 0) {
                            val end = rest.indexOf('"', start + 1)
                            if (end > start) {
                                val v = rest.substring(start + 1, end).trim()
                                if (v.isNotEmpty() && File(v).isDirectory) return v
                            }
                        }
                    }
                }
            }
        } catch (_: Exception) {
        }
        // 2. env
        System.getenv("BURP_AGENT_SIDECAR_DIR")?.takeIf { it.isNotBlank() && File(it).isDirectory }?.let { return it }
        // 3. sysprop
        System.getProperty("burp.agent.sidecarDir")?.takeIf { it.isNotBlank() && File(it).isDirectory }?.let { return it }
        return null
    }

    /** Best-effort repo root candidates. Returns the root (parent containing /sidecar) or null. */
    private fun repoRoot(): File? {
        // explicit sidecar dir implies root
        val explicit = explicitSidecarDir()
        if (explicit != null) return File(explicit).parentFile

        val envRoot = System.getenv("BURP_AGENT_REPO")
        if (!envRoot.isNullOrBlank() && File(File(envRoot), "sidecar").isDirectory) return File(envRoot)

        val propRoot = System.getProperty("burp.agent.repo")
        if (!propRoot.isNullOrBlank() && File(File(propRoot), "sidecar").isDirectory) return File(propRoot)

        // jar location (works when the jar sits inside the repo, e.g. build/libs)
        try {
            val jarPath = SidecarManager::class.java.protectionDomain.codeSource?.location?.toURI()?.path
            if (jarPath != null) {
                var dir = File(jarPath).parentFile
                var depth = 0
                while (dir != null && depth < 4) {
                    if (File(dir, "sidecar").isDirectory) return dir
                    dir = dir.parentFile
                    depth++
                }
            }
        } catch (_: Exception) {
        }

        val cwd = File(System.getProperty("user.dir"))
        if (File(cwd, "sidecar").isDirectory) return cwd
        val parent = cwd.parentFile
        if (parent != null && File(parent, "sidecar").isDirectory) return parent

        // user.home
        val home = File(System.getProperty("user.home") ?: "")
        if (File(home, "sidecar").isDirectory) return home

        return null
    }

    private fun resolveCommand(): List<String>? {
        val explicit = explicitSidecarDir()
        val root = repoRoot()
        val sidecarDir: File? = when {
            explicit != null -> File(explicit)
            root != null -> File(root, "sidecar")
            else -> null
        }
        if (sidecarDir == null || !sidecarDir.isDirectory) return null

        val binDir = File(sidecarDir, "bin")
        val exeName = if (isWindows) "burp-sidecar.exe" else "burp-sidecar"
        val bundled = File(binDir, exeName)
        if (bundled.isFile) return listOf(bundled.absolutePath)

        val node = resolveNode() ?: return null

        val dist = File(sidecarDir, "dist" + File.separator + "index.js")
        if (dist.isFile) return listOf(node, dist.absolutePath)

        val nodeModulesBin = File(sidecarDir, "node_modules" + File.separator + ".bin")
        val tsxBin = if (isWindows) File(nodeModulesBin, "tsx.cmd") else File(nodeModulesBin, "tsx")
        if (tsxBin.exists()) {
            return listOf(node, "--import", "tsx", File(sidecarDir, "src" + File.separator + "index.ts").absolutePath)
        }
        return null
    }

    /** Resolve an absolute node executable (Windows-friendly). */
    private fun resolveNode(): String? {
        // common install locations first (Windows)
        if (isWindows) {
            val candidates = listOf(
                System.getenv("ProgramFiles"),
                System.getenv("ProgramFiles(x86)"),
                System.getenv("LOCALAPPDATA"),
                System.getenv("APPDATA"),
            ).filterNotNull()
            for (base in candidates) {
                val p = File(base, "nodejs" + File.separator + "node.exe")
                if (p.isFile) return p.absolutePath
            }
            val nvm = File(System.getenv("NVM_HOME") ?: "", "node.exe")
            if (nvm.isFile) return nvm.absolutePath
        }
        // PATH lookup via `where` / `which`
        try {
            val cmd = if (isWindows) listOf("where", "node") else listOf("which", "node")
            val pb = ProcessBuilder(cmd)
            pb.redirectErrorStream(true)
            val proc = pb.start()
            val out = proc.inputStream.bufferedReader().readText().trim()
            proc.waitFor(3, TimeUnit.SECONDS)
            val line = out.lineSequence().firstOrNull { it.isNotBlank() }
            if (line != null) {
                val abs = if (isWindows && !line.startsWith("\\")) line else line
                if (File(abs).isFile) return abs
            }
        } catch (_: Exception) {
        }
        return "node"
    }

    sealed class StartResult {
        data object Success : StartResult()
        data class Failure(val reason: String) : StartResult()
    }
}
