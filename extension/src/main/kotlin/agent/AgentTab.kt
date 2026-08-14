package agent

import agent.rpc.Json
import com.google.gson.JsonObject
import burp.api.montoya.ui.Theme
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import javax.swing.BorderFactory
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JLabel
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
        ctx.api.userInterface().applyThemeToComponent(root)
    }

    private fun buildStatusPanel(): JComponent {
        val panel = JPanel(BorderLayout())
        val info = JPanel()
        info.border = BorderFactory.createTitledBorder("Sidecar")
        statusLabel.font = statusLabel.font.deriveFont(Font.BOLD)
        versionLabel.font = versionLabel.font.deriveFont(Font.PLAIN, 11f)
        providersLabel.font = providersLabel.font.deriveFont(Font.PLAIN, 11f)
        info.add(statusLabel)
        info.add(versionLabel)
        info.add(providersLabel)
        info.layout = FlowLayout(FlowLayout.LEFT)
        panel.add(info, BorderLayout.NORTH)

        val buttons = JPanel(FlowLayout(FlowLayout.LEFT))
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
        panel.add(buttons, BorderLayout.SOUTH)

        val config = JPanel(BorderLayout())
        config.border = BorderFactory.createTitledBorder("Sidecar location (Windows)")
        val dirLabel = JLabel("sidecar dir: ")
        dirLabel.font = dirLabel.font.deriveFont(Font.PLAIN, 11f)
        sidecarDirField.text = loadSidecarDirConfig()
        sidecarDirField.font = sidecarDirField.font.deriveFont(Font.PLAIN, 11f)
        val saveDir = JButton("Save & start")
        saveDir.addActionListener {
            val dir = sidecarDirField.text.trim().trimEnd('/', '\\')
            saveSidecarDirConfig(dir)
            ctx.sidecar?.start()
            statusLabel.text = "sidecar: starting..."
        }
        val dirRow = JPanel(BorderLayout())
        dirRow.add(dirLabel, BorderLayout.WEST)
        dirRow.add(sidecarDirField, BorderLayout.CENTER)
        dirRow.add(saveDir, BorderLayout.EAST)
        config.add(dirRow, BorderLayout.CENTER)
        config.add(
            JLabel("Path to the sidecar folder containing dist/index.js (e.g. E:/lab/burp/sidecar). Saved to ~/.burp-agent/sidecar.json"),
            BorderLayout.NORTH,
        )
        panel.add(config, BorderLayout.CENTER)
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
        output.preferredSize = Dimension(800, 360)
        val input = JScrollPane(chatInput)
        input.preferredSize = Dimension(800, 90)
        val sendButton = JButton("Send")
        sendButton.addActionListener { sendChat() }
        val inputRow = JPanel(BorderLayout())
        inputRow.add(input, BorderLayout.CENTER)
        inputRow.add(sendButton, BorderLayout.EAST)
        val split = JSplitPane(JSplitPane.VERTICAL_SPLIT, output, inputRow)
        split.resizeWeight = 0.8
        val panel = JPanel(BorderLayout())
        panel.add(split, BorderLayout.CENTER)
        return panel
    }

    private fun buildLogPanel(): JComponent {
        val table = JTable(logModel)
        table.autoResizeMode = JTable.AUTO_RESIZE_LAST_COLUMN
        val scroll = JScrollPane(table)
        scroll.preferredSize = Dimension(900, 300)
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
