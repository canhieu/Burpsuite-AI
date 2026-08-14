package agent

import agent.rpc.Json
import com.google.gson.JsonObject
import burp.api.montoya.ui.Theme
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JOptionPane
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JSplitPane
import javax.swing.JTabbedPane
import javax.swing.JTable
import javax.swing.JTextArea
import javax.swing.JTextField
import javax.swing.JTextPane
import javax.swing.SwingUtilities
import javax.swing.table.AbstractTableModel
import javax.swing.text.html.HTMLEditorKit

class AgentTab(private val ctx: AgentContext) {

    private val root = JPanel(BorderLayout())
    private val tabs = JTabbedPane()

    private val statusLabel = JLabel("sidecar: not connected")
    private val versionLabel = JLabel("")
    private val providersLabel = JLabel("providers: -")
    private val startButton = JButton("Start sidecar")
    private val stopButton = JButton("Stop")
    private val stopAllButton = JButton("STOP ALL")
    private val loginCodexButton = JButton("Login Codex")
    private val loginClaudeButton = JButton("Login Claude")
    private val sidecarDirField = JTextField(40)

    private val chatInput = JTextArea(4, 80)
    private val chatOutput = JTextPane()
    private val logModel = LogTableModel(ctx.audit)

    fun component(): JComponent = root

    init {
        chatOutput.contentType = "text/html"
        chatOutput.editorKit = HTMLEditorKit()
        chatOutput.isEditable = false
        chatOutput.text = "<html><body></body></html>"

        tabs.addTab("Status", buildStatusPanel())
        tabs.addTab("Chat", buildChatPanel())
        tabs.addTab("Log", buildLogPanel())
        root.add(tabs, BorderLayout.CENTER)
        root.preferredSize = Dimension(920, 640)
        ctx.api.userInterface().applyThemeToComponent(root)
    }

    private fun buildStatusPanel(): JComponent {
        val panel = JPanel(GridBagLayout())
        val gbc = GridBagConstraints()
        gbc.insets = Insets(8, 10, 8, 10)
        gbc.fill = GridBagConstraints.HORIZONTAL
        gbc.weightx = 1.0

        // Section 1: connection status
        val statusCard = JPanel()
        statusCard.layout = BoxLayout(statusCard, BoxLayout.Y_AXIS)
        statusCard.border = BorderFactory.createTitledBorder("Connection")
        statusLabel.font = statusLabel.font.deriveFont(Font.BOLD)
        versionLabel.font = versionLabel.font.deriveFont(Font.PLAIN, 11f)
        providersLabel.font = providersLabel.font.deriveFont(Font.PLAIN, 11f)
        statusLabel.alignmentX = 0f
        versionLabel.alignmentX = 0f
        providersLabel.alignmentX = 0f
        statusCard.add(statusLabel)
        statusCard.add(Box.createVerticalStrut(4))
        statusCard.add(versionLabel)
        statusCard.add(Box.createVerticalStrut(4))
        statusCard.add(providersLabel)

        val buttons = JPanel(FlowLayout(FlowLayout.LEFT, 6, 0))
        buttons.alignmentX = 0f
        startButton.addActionListener {
            ctx.sidecar?.start()
            statusLabel.text = "sidecar: starting..."
        }
        stopButton.addActionListener { ctx.sidecar?.stop() }
        stopAllButton.foreground = Color.WHITE
        stopAllButton.background = Color.RED
        stopAllButton.preferredSize = Dimension(120, 28)
        stopAllButton.addActionListener {
            ctx.policy.killAll.set(true)
            statusLabel.text = "sidecar: STOP ALL (kill switch on)"
            ctx.audit.add("error", "stop_all", "kill switch engaged by user", "ok")
            stopAllButton.isEnabled = false
        }
        buttons.add(startButton)
        buttons.add(stopButton)
        buttons.add(stopAllButton)
        statusCard.add(Box.createVerticalStrut(8))
        statusCard.add(buttons)

        // Login row
        val loginRow = JPanel(FlowLayout(FlowLayout.LEFT, 6, 0))
        loginRow.alignmentX = 0f
        loginCodexButton.toolTipText = "OpenAI/Codex login via device code (uses ~/.codex/auth.json)"
        loginClaudeButton.toolTipText = "Anthropic Claude login via browser (uses ~/.claude/.credentials.json)"
        loginCodexButton.addActionListener { startOAuthLogin("openai") }
        loginClaudeButton.addActionListener { startOAuthLogin("anthropic") }
        loginRow.add(JLabel("OAuth:"))
        loginRow.add(loginCodexButton)
        loginRow.add(loginClaudeButton)
        statusCard.add(Box.createVerticalStrut(4))
        statusCard.add(loginRow)

        gbc.gridy = 0
        panel.add(statusCard, gbc)

        // Section 2: sidecar location (Windows)
        val config = JPanel(GridBagLayout())
        config.border = BorderFactory.createTitledBorder("Sidecar location (Windows)")
        val cgbc = GridBagConstraints()
        cgbc.insets = Insets(4, 8, 4, 8)
        cgbc.fill = GridBagConstraints.HORIZONTAL
        cgbc.weightx = 1.0
        cgbc.gridx = 0
        cgbc.gridy = 0
        val dirLabel = JLabel("sidecar dir:")
        dirLabel.font = dirLabel.font.deriveFont(Font.PLAIN, 11f)
        config.add(dirLabel, cgbc)
        cgbc.gridy = 1
        sidecarDirField.text = loadSidecarDirConfig()
        sidecarDirField.font = sidecarDirField.font.deriveFont(Font.PLAIN, 11f)
        config.add(sidecarDirField, cgbc)
        cgbc.gridy = 2
        val hint = JLabel("Path to the sidecar folder containing dist/index.js (e.g. E:/lab/burp/sidecar). Saved to ~/.burp-agent/sidecar.json")
        hint.font = hint.font.deriveFont(Font.PLAIN, 10f)
        config.add(hint, cgbc)
        cgbc.gridy = 3
        cgbc.fill = GridBagConstraints.NONE
        cgbc.anchor = GridBagConstraints.WEST
        val saveDir = JButton("Save & start")
        saveDir.addActionListener {
            val dir = sidecarDirField.text.trim().trimEnd('/', '\\')
            saveSidecarDirConfig(dir)
            ctx.sidecar?.start()
            statusLabel.text = "sidecar: starting..."
        }
        config.add(saveDir, cgbc)

        gbc.gridy = 1
        gbc.weighty = 1.0
        gbc.fill = GridBagConstraints.BOTH
        panel.add(config, gbc)

        return panel
    }

    private fun loadSidecarDirConfig(): String {
        return try {
            val home = System.getProperty("user.home") ?: return ""
            val f = java.io.File(java.io.File(home, ".burp-agent"), "sidecar.json")
            if (!f.isFile) return ""
            val idx = f.readText().indexOf("\"sidecarDir\"")
            if (idx < 0) return ""
            val rest = f.readText().substring(idx + 13)
            val s = rest.indexOf('"')
            if (s < 0) return ""
            val e = rest.indexOf('"', s + 1)
            if (e > s) rest.substring(s + 1, e) else ""
        } catch (_: Exception) {
            ""
        }
    }

    private fun saveSidecarDirConfig(dir: String) {
        try {
            val home = System.getProperty("user.home") ?: return
            val base = java.io.File(home, ".burp-agent")
            if (!base.exists()) base.mkdirs()
            java.io.File(base, "sidecar.json").writeText(
                "{\n  \"sidecarDir\": \"$dir\"\n}\n"
            )
            ctx.audit.add("info", "sidecar.config", dir, "ok")
        } catch (e: Exception) {
            ctx.audit.add("error", "sidecar.config", e.message ?: "write failed", "failed")
        }
    }

    private fun buildChatPanel(): JComponent {
        val output = JScrollPane(chatOutput)
        output.border = BorderFactory.createTitledBorder("Conversation")
        val input = JScrollPane(chatInput)
        input.border = BorderFactory.createTitledBorder("Input")
        val sendButton = JButton("Send")
        sendButton.addActionListener { sendChat() }
        val inputRow = JPanel(BorderLayout())
        inputRow.add(input, BorderLayout.CENTER)
        inputRow.add(sendButton, BorderLayout.EAST)
        val split = JSplitPane(JSplitPane.VERTICAL_SPLIT, output, inputRow)
        split.resizeWeight = 0.85
        split.setContinuousLayout(true)
        split.dividerLocation = 480
        val panel = JPanel(BorderLayout())
        panel.add(split, BorderLayout.CENTER)
        return panel
    }

    private fun buildLogPanel(): JComponent {
        val table = JTable(logModel)
        table.autoResizeMode = JTable.AUTO_RESIZE_LAST_COLUMN
        table.fillsViewportHeight = true
        val scroll = JScrollPane(table)
        return scroll
    }

    private fun sendChat() {
        val text = chatInput.text.trim()
        if (text.isEmpty()) return
        chatInput.text = ""
        appendChat("assistant", "user", text)
        val rpc = ctx.rpcServer ?: run {
            appendChat("system", "error", "rpc server not ready")
            return
        }
        val params = Json.obj(
            "messages" to listOf(Json.obj("role" to "user", "content" to text)),
            "stream" to true,
        )
        Thread {
            val reply = rpc.callSidecar("agent.chat", params, timeoutMs = 120000)
            if (reply.error != null) {
                appendChat("system", "error", "agent.chat: ${reply.error.message}")
            }
        }.apply { isDaemon = true; name = "agent-chat" }.start()
    }

    private fun startOAuthLogin(provider: String) {
        val rpc = ctx.rpcServer
        if (rpc == null || !ctx.connected) {
            JOptionPane.showMessageDialog(root, "Sidecar not connected. Start the sidecar first.")
            return
        }
        val flow = if (provider == "openai") "device" else "browser"
        Thread {
            val reply = rpc.callSidecar(
                "auth.login.start",
                Json.obj("provider" to provider, "flow" to flow),
                timeoutMs = 30000,
            )
            if (reply.error != null) {
                SwingUtilities.invokeLater {
                    JOptionPane.showMessageDialog(root, "Login failed: ${reply.error.message}", "Login", JOptionPane.ERROR_MESSAGE)
                }
                return@Thread
            }
            val result = reply.result ?: return@Thread
            val state = result.takeIf { it.isJsonObject }?.asJsonObject?.get("state")?.asString ?: "error"
            if (state != "pending") {
                val detail = result.asJsonObject?.get("detail")?.asString ?: "unknown error"
                SwingUtilities.invokeLater {
                    JOptionPane.showMessageDialog(root, "Login error: $detail", "Login", JOptionPane.ERROR_MESSAGE)
                }
                return@Thread
            }
            val obj = result.asJsonObject
            val userCode = obj.get("userCode")?.takeIf { !it.isJsonNull }?.asString ?: ""
            val uri = obj.get("verificationUri")?.takeIf { !it.isJsonNull }?.asString ?: ""
            val loginId = obj.get("loginId")?.takeIf { !it.isJsonNull }?.asString ?: obj.get("flowId")?.takeIf { !it.isJsonNull }?.asString ?: ""
            val deviceCode = obj.get("deviceCode")?.takeIf { !it.isJsonNull }?.asString ?: ""
            val interval = obj.get("interval")?.takeIf { it.isJsonPrimitive }?.asInt ?: 5
            SwingUtilities.invokeLater {
                val msg = buildString {
                    if (userCode.isNotEmpty()) append("Your code: $userCode\n")
                    if (uri.isNotEmpty()) append("Open: $uri\n")
                    append("\nWaiting for approval...")
                }
                JOptionPane.showMessageDialog(root, msg, "${provider} Login", JOptionPane.INFORMATION_MESSAGE)
            }
            // poll until success/error
            val deadline = System.currentTimeMillis() + 10 * 60 * 1000
            while (System.currentTimeMillis() < deadline) {
                Thread.sleep(interval.coerceIn(1, 15) * 1000L)
                val poll = rpc.callSidecar(
                    "auth.login.poll",
                    Json.obj("provider" to provider, "flowId" to loginId, "deviceCode" to deviceCode, "interval" to interval),
                    timeoutMs = 15000,
                )
                val pState = poll.result?.takeIf { it.isJsonObject }?.asJsonObject?.get("state")?.asString ?: "error"
                if (pState == "success") {
                    SwingUtilities.invokeLater {
                        JOptionPane.showMessageDialog(root, "Logged in to $provider", "Login", JOptionPane.INFORMATION_MESSAGE)
                        refreshProviders()
                    }
                    return@Thread
                }
                if (pState == "error") {
                    val detail = poll.result?.asJsonObject?.get("detail")?.asString ?: "login failed"
                    SwingUtilities.invokeLater {
                        JOptionPane.showMessageDialog(root, "Login failed: $detail", "Login", JOptionPane.ERROR_MESSAGE)
                    }
                    return@Thread
                }
            }
        }.apply { isDaemon = true; name = "agent-oauth" }.start()
    }

    fun appendChat(prefix: String, kind: String, text: String) {
        SwingUtilities.invokeLater {
            val color = when (kind) {
                "tool" -> "#3366cc"
                "result" -> "#3366cc"
                "error" -> "#cc3333"
                "done" -> "#339933"
                "user" -> "#444444"
                else -> "#888888"
            }
            val escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("\n", "<br>")
            val current = chatOutput.text
            val body = current.substringAfter("<body>", "").substringBefore("</body>", "")
            val line = if (prefix.isBlank()) "<p><span style='color:$color'>$escaped</span></p>"
            else "<p><b style='color:$color'>[$prefix]</b> <span style='color:$color'>$escaped</span></p>"
            chatOutput.text = "<html><body>${body}$line</body></html>"
        }
    }

    fun onSidecarConnected(version: String) {
        SwingUtilities.invokeLater {
            statusLabel.text = "sidecar: connected"
            versionLabel.text = "extension $version"
            startButton.isEnabled = false
            stopButton.isEnabled = true
            refreshProviders()
        }
    }

    fun onSidecarDisconnected() {
        SwingUtilities.invokeLater {
            statusLabel.text = "sidecar: disconnected"
            versionLabel.text = ""
            startButton.isEnabled = true
            stopButton.isEnabled = false
        }
    }

    fun onSidecarEvent(method: String, params: JsonObject) {
        when (method) {
            "agent.event" -> {
                val type = params.get("type")?.asString ?: "text"
                val data = params.get("data")?.takeIf { !it.isJsonNull }?.toString() ?: ""
                appendChat("agent", type, data)
            }
            "auth.status.changed" -> SwingUtilities.invokeLater { renderProviders(params) }
            "approval.requested" -> promptApproval(params)
            else -> {
            }
        }
    }

    fun refreshProviders() {
        val rpc = ctx.rpcServer ?: return
        Thread {
            val reply = rpc.callSidecar("auth.status", null, timeoutMs = 10000)
            if (reply.error == null && reply.result != null && reply.result.isJsonObject) {
                renderProviders(reply.result.asJsonObject)
            }
        }.apply { isDaemon = true }.start()
    }

    private fun renderProviders(params: JsonObject) {
        SwingUtilities.invokeLater {
            val providers = params.get("providers")?.takeIf { it.isJsonArray }?.asJsonArray
            providersLabel.text = providers?.let { arr ->
                "providers: " + arr.mapNotNull { it.takeIf { e -> e.isJsonObject }?.asJsonObject }
                    .joinToString(", ") { p ->
                        val name = p.get("provider")?.asString ?: "?"
                        val ok = p.get("connected")?.asBoolean == true
                        "$name=${if (ok) "on" else "off"}"
                    }
            } ?: "providers: -"
        }
    }

    private fun promptApproval(params: JsonObject) {
        val request = params.get("request")?.takeIf { it.isJsonObject }?.asJsonObject ?: return
        val requestId = request.get("id")?.asString ?: return
        val reason = request.get("reason")?.asString ?: "approval request"
        val target = request.get("target")?.takeIf { !it.isJsonNull }?.asString ?: ""
        SwingUtilities.invokeLater {
            val choice = javax.swing.JOptionPane.showConfirmDialog(
                root,
                "Agent requests approval:\n$reason\n$target\n\nApprove?",
                "Agent Approval",
                javax.swing.JOptionPane.YES_NO_OPTION,
                javax.swing.JOptionPane.WARNING_MESSAGE,
            )
            val approved = choice == javax.swing.JOptionPane.YES_OPTION
            ctx.rpcServer?.sendNotification(
                "agent.approve",
                Json.obj("requestId" to requestId, "approved" to approved)
            )
        }
    }

    fun showError(message: String) {
        SwingUtilities.invokeLater {
            statusLabel.text = "sidecar: error"
            versionLabel.text = message
            appendChat("system", "error", message)
        }
    }

    fun focusTab() {
        SwingUtilities.invokeLater { tabs.selectedIndex = 1 }
    }

    class LogTableModel(private val audit: AuditLog) : AbstractTableModel() {
        private val columns = arrayOf("time", "method", "target", "status")
        private var rows: List<AuditEntry> = audit.all()

        init {
            audit.listener = { _ ->
                SwingUtilities.invokeLater {
                    rows = audit.all()
                    fireTableDataChanged()
                }
            }
        }

        override fun getRowCount(): Int = rows.size
        override fun getColumnCount(): Int = columns.size
        override fun getColumnName(column: Int): String = columns[column]
        override fun getValueAt(row: Int, column: Int): Any? {
            val e = rows[row]
            return when (column) {
                0 -> e.timeIso
                1 -> e.method
                2 -> e.target
                else -> e.status
            }
        }
    }
}
