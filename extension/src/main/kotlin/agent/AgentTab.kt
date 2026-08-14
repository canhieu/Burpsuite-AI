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
import javax.swing.JCheckBox
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JOptionPane
import javax.swing.JPanel
import javax.swing.JPasswordField
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

    // Settings tab: provider rows
    private data class ProviderRow(val name: String, val label: String)
    private val providerRows = listOf(
        ProviderRow("shineshop", "ShineShop (OpenAI-compatible)"),
        ProviderRow("deepseek", "DeepSeek"),
        ProviderRow("openai", "OpenAI / Compatible"),
        ProviderRow("anthropic", "Anthropic Claude"),
        ProviderRow("ollama", "Ollama (local)"),
    )
    private val providerEnabled = providerRows.associate { it.name to JCheckBox() }
    private val providerBaseUrl = providerRows.associate { it.name to JTextField(36) }
    private val providerApiKey = providerRows.associate { it.name to JPasswordField(30) }
    private val settingsStatus = JLabel("settings: -")

    // Chat model selection
    private val chatProviderCombo = JComboBox(providerRows.map { it.name }.toTypedArray())
    private val chatModelCombo = JComboBox<String>()
    private var chatModels: List<String> = emptyList()
    private val chatReasoningCombo = JComboBox(arrayOf("auto", "low", "medium", "high", "xhigh", "max"))

    private val chatBody = StringBuilder()
    private val streamBuffer = StringBuilder()
    private var streaming = false

    // conversation memory across runs: user asks + observed tool activity
    private val conversation = StringBuilder()

    fun component(): JComponent = root

    init {
        chatOutput.contentType = "text/html"
        chatOutput.editorKit = HTMLEditorKit()
        chatOutput.isEditable = false
        chatOutput.text = "<html><body></body></html>"

        tabs.addTab("Status", buildStatusPanel())
        tabs.addTab("Chat", buildChatPanel())
        tabs.addTab("Settings", buildSettingsPanel())
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
        chatOutput.contentType = "text/html"
        chatOutput.isEditable = false
        chatOutput.background = Color(245, 246, 250)
        val output = JScrollPane(chatOutput)
        output.border = BorderFactory.createEmptyBorder()
        output.isOpaque = false
        output.viewport.isOpaque = false

        chatInput.background = Color.WHITE
        chatInput.font = Font(Font.SANS_SERIF, Font.PLAIN, 13)
        val inputScroll = JScrollPane(chatInput)
        inputScroll.border = BorderFactory.createCompoundBorder(
            BorderFactory.createLineBorder(Color(200, 205, 215), 1),
            BorderFactory.createEmptyBorder(4, 4, 4, 4)
        )
        inputScroll.preferredSize = Dimension(700, 72)
        val sendButton = JButton("Send")
        sendButton.font = Font(Font.SANS_SERIF, Font.BOLD, 13)
        sendButton.background = Color(52, 120, 246)
        sendButton.foreground = Color.WHITE
        sendButton.border = BorderFactory.createEmptyBorder(8, 18, 8, 18)
        sendButton.isFocusPainted = false
        sendButton.addActionListener { sendChat() }
        val inputRow = JPanel(BorderLayout(8, 0))
        inputRow.border = BorderFactory.createEmptyBorder(10, 12, 10, 12)
        inputRow.background = Color(245, 246, 250)
        inputRow.add(inputScroll, BorderLayout.CENTER)
        inputRow.add(sendButton, BorderLayout.EAST)

        // Model selector row
        chatModelCombo.isEditable = true
        chatModelCombo.prototypeDisplayValue = "deepseek-v4-flash"
        chatProviderCombo.addActionListener { refreshChatModels() }
        chatModelCombo.addActionListener { persistChatModelSelection() }
        val modelRow = JPanel(FlowLayout(FlowLayout.LEFT, 10, 6))
        modelRow.background = Color(255, 255, 255)
        modelRow.border = BorderFactory.createCompoundBorder(
            BorderFactory.createMatteBorder(0, 0, 1, 0, Color(225, 229, 238)),
            BorderFactory.createEmptyBorder(4, 12, 4, 12)
        )
        modelRow.add(styleLabel("Provider"))
        modelRow.add(chatProviderCombo)
        modelRow.add(styleLabel("Model"))
        modelRow.add(chatModelCombo)
        modelRow.add(styleLabel("Reasoning"))
        modelRow.add(chatReasoningCombo)

        val split = JSplitPane(JSplitPane.VERTICAL_SPLIT, output, inputRow)
        split.resizeWeight = 0.9
        split.setContinuousLayout(true)
        split.dividerLocation = 480
        val panel = JPanel(BorderLayout())
        panel.add(modelRow, BorderLayout.NORTH)
        panel.add(split, BorderLayout.CENTER)
        return panel
    }

    private fun styleLabel(text: String): JLabel {
        val l = JLabel(text)
        l.font = Font(Font.SANS_SERIF, Font.BOLD, 11)
        l.foreground = Color(110, 118, 132)
        return l
    }

    private fun refreshChatModels() {
        val rpc = ctx.rpcServer ?: return
        val provider = chatProviderCombo.selectedItem?.toString() ?: "openai"
        Thread {
            val reply = rpc.callSidecar("models.list", Json.obj("provider" to provider), timeoutMs = 15000)
            if (reply.error != null || reply.result == null) return@Thread
            val models = reply.result.asJsonObject.get("models")?.takeIf { it.isJsonArray }?.asJsonArray ?: return@Thread
            val ids = models.mapNotNull { it.takeIf { e -> e.isJsonObject }?.asJsonObject?.get("id")?.takeIf { x -> !x.isJsonNull }?.asString }
            SwingUtilities.invokeLater {
                val prev = chatModelCombo.editor.item?.toString() ?: ""
                chatModelCombo.removeAllItems()
                for (id in ids) chatModelCombo.addItem(id)
                if (ids.isNotEmpty() && prev.isNotEmpty() && ids.contains(prev)) {
                    chatModelCombo.selectedItem = prev
                }
            }
        }.apply { isDaemon = true; name = "models-list" }.start()
    }

    private fun persistChatModelSelection() {
        val rpc = ctx.rpcServer ?: return
        val model = chatModelCombo.editor.item?.toString() ?: chatModelCombo.selectedItem?.toString() ?: return
        val provider = chatProviderCombo.selectedItem?.toString() ?: "openai"
        Thread {
            rpc.callSidecar(
                "settings.set",
                Json.obj("patch" to com.google.gson.JsonObject().apply {
                    addProperty("chat.provider", provider)
                    addProperty("chat.model", model)
                }),
                timeoutMs = 8000,
            )
        }.apply { isDaemon = true; name = "settings-chat-model" }.start()
    }

    private fun loadChatModelSelection() {
        val rpc = ctx.rpcServer ?: return
        Thread {
            val reply = rpc.callSidecar("settings.get", Json.obj("paths" to listOf("chat.provider", "chat.model")), timeoutMs = 10000)
            if (reply.error != null || reply.result == null) return@Thread
            val settings = reply.result.asJsonObject.get("settings")?.takeIf { it.isJsonObject }?.asJsonObject ?: return@Thread
            val provider = settings.get("chat.provider")?.takeIf { !it.isJsonNull }?.asString
            val model = settings.get("chat.model")?.takeIf { !it.isJsonNull }?.asString
            SwingUtilities.invokeLater {
                if (provider != null && providerRows.any { it.name == provider }) {
                    chatProviderCombo.selectedItem = provider
                }
                if (model != null && !model.isBlank()) {
                    chatModelCombo.selectedItem = model
                }
            }
        }.apply { isDaemon = true; name = "settings-load-chat" }.start()
    }

    private fun buildLogPanel(): JComponent {
        val table = JTable(logModel)
        table.autoResizeMode = JTable.AUTO_RESIZE_LAST_COLUMN
        table.fillsViewportHeight = true
        val scroll = JScrollPane(table)
        return scroll
    }

    private fun buildSettingsPanel(): JComponent {
        val panel = JPanel()
        panel.layout = BoxLayout(panel, BoxLayout.Y_AXIS)
        panel.border = BorderFactory.createEmptyBorder(10, 12, 12, 12)

        // ---- Providers card ----
        val card = JPanel()
        card.layout = BoxLayout(card, BoxLayout.Y_AXIS)
        card.border = BorderFactory.createTitledBorder("Providers (Base URL + API Key)")
        val header = JPanel(FlowLayout(FlowLayout.LEFT, 8, 2))
        header.add(JLabel("On"))
        header.add(JLabel("Provider"))
        header.add(JLabel("Base URL"))
        header.add(JLabel("API Key"))
        card.add(header)
        for (row in providerRows) {
            val line = JPanel(FlowLayout(FlowLayout.LEFT, 8, 3))
            val en = providerEnabled.getValue(row.name)
            en.toolTipText = "Enable ${row.name} provider"
            line.add(en)
            line.add(JLabel(row.label).apply { preferredSize = Dimension(150, 20) })
            line.add(providerBaseUrl.getValue(row.name).apply { preferredSize = Dimension(420, 24) })
            line.add(providerApiKey.getValue(row.name).apply { preferredSize = Dimension(260, 24) })
            card.add(line)
        }
        val saveBtn = JButton("Save provider settings")
        saveBtn.addActionListener { saveProviderSettings() }
        val reloadBtn = JButton("Load current")
        reloadBtn.addActionListener { loadProviderSettings() }
        val btnRow = JPanel(FlowLayout(FlowLayout.LEFT, 8, 4))
        btnRow.add(saveBtn)
        btnRow.add(reloadBtn)
        btnRow.add(settingsStatus)
        card.add(btnRow)
        panel.add(card)
        panel.add(Box.createVerticalStrut(10))

        // ---- Help hint ----
        val hint = JLabel("<html>Base URL is the OpenAI-compatible endpoint, e.g. <b>https://api.shineshop.dev/v1</b>.<br>" +
            "Global API Key is the provider key for that endpoint (stored in the sidecar data dir, mode 0600)." +
            "<br>Leave API Key empty to clear. Keys in the environment (OPENAI_API_KEY) still take precedence.</html>")
        hint.font = hint.font.deriveFont(Font.PLAIN, 11f)
        panel.add(hint)

        return JScrollPane(panel)
    }

    private fun loadProviderSettings() {
        val rpc = ctx.rpcServer ?: return
        Thread {
            val reply = rpc.callSidecar("config.get", null, timeoutMs = 10000)
            if (reply.error != null || reply.result == null || !reply.result.isJsonObject) {
                settingsStatus.text = "settings: load failed"
                return@Thread
            }
            val providers = reply.result.asJsonObject.get("providers")?.takeIf { it.isJsonObject }?.asJsonObject
                ?: return@Thread
            SwingUtilities.invokeLater {
                for (name in providerRows.map { it.name }) {
                    val p = providers.get(name)?.takeIf { it.isJsonObject }?.asJsonObject ?: continue
                    providerEnabled.getValue(name).isSelected = p.get("enabled")?.asBoolean == true
                    providerBaseUrl.getValue(name).text = p.get("baseUrl")?.takeIf { !it.isJsonNull }?.asString ?: ""
                    providerApiKey.getValue(name).text = ""
                }
                settingsStatus.text = "settings: loaded"
            }
        }.apply { isDaemon = true; name = "settings-load" }.start()
    }

    private fun saveProviderSettings() {
        val rpc = ctx.rpcServer ?: run {
            settingsStatus.text = "settings: sidecar not connected"
            return
        }
        val providers = com.google.gson.JsonObject()
        for (name in providerRows.map { it.name }) {
            val p = com.google.gson.JsonObject()
            p.addProperty("enabled", providerEnabled.getValue(name).isSelected)
            p.addProperty("baseUrl", providerBaseUrl.getValue(name).text.trim())
            val key = String(providerApiKey.getValue(name).password)
            p.addProperty("apiKey", key)
            providers.add(name, p)
        }
        Thread {
            val reply = rpc.callSidecar("config.set", Json.obj("providers" to providers), timeoutMs = 15000)
            SwingUtilities.invokeLater {
                if (reply.error != null) {
                    settingsStatus.text = "settings: save failed: ${reply.error.message}"
                } else {
                    settingsStatus.text = "settings: saved"
                    refreshProviders()
                }
            }
        }.apply { isDaemon = true; name = "settings-save" }.start()
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
        // carry prior context into the next run so the agent is not memoryless
        val context = conversation.toString().trim()
        val fullTask = if (context.isEmpty()) text else "$context\n\nNew instruction: $text"
        conversation.append("USER: ").append(text).append('\n')
        val provider = chatProviderCombo.selectedItem?.toString() ?: "shineshop"
        val model = chatModelCombo.editor.item?.toString()?.takeIf { it.isNotBlank() }
            ?: chatModelCombo.selectedItem?.toString() ?: ""
        val modelArg = Json.obj("provider" to provider, "model" to model)
        val params = Json.obj(
            "task" to fullTask,
            "mode" to "smart",
            "models" to Json.obj(
                "planner" to modelArg,
                "executor" to modelArg,
                "reviewer" to modelArg,
            ),
        )
        Thread {
            val reply = rpc.callSidecar("agent.run.start", params, timeoutMs = 30000)
            if (reply.error != null) {
                appendChat("system", "error", "agent.run.start: ${reply.error.message}")
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
            flushStream()
            when (kind) {
                "user" -> appendUserBubble(text)
                "tool" -> appendChip("tool", text, "#3366cc")
                "done" -> appendChip("run", text, "#339933")
                "error" -> appendChip("error", text, "#cc3333")
                else -> appendAgentBubble(text)
            }
            renderChat()
        }
    }

    private fun appendUserBubble(text: String) {
        val escaped = escapeHtml(text)
        chatBody.append("<table width='100%' cellpadding='0' cellspacing='0' border='0'>")
            .append("<tr><td align='right'><div style='background:#3b82f6;color:#fff;border-radius:12px 12px 2px 12px;padding:8px 12px;max-width:85%;text-align:left;display:inline-block;margin:4px 0;'>")
            .append(escaped)
            .append("</div></td></tr></table>")
    }

    private fun appendAgentBubble(text: String) {
        val escaped = escapeHtml(text)
        chatBody.append("<table width='100%' cellpadding='0' cellspacing='0' border='0'>")
            .append("<tr><td><div style='background:#ffffff;border:1px solid #e3e7ef;border-radius:12px 12px 12px 2px;padding:8px 12px;max-width:85%;display:inline-block;margin:4px 0;'>")
            .append(escaped)
            .append("</div></td></tr></table>")
    }

    private fun appendChip(label: String, text: String, color: String) {
        val escaped = escapeHtml(text)
        chatBody.append("<div style='margin:3px 0 3px 4px;'><span style='font-size:11px;font-family:monospace;background:#f0f2f7;color:")
            .append(color)
            .append(";border:1px solid #e0e4ee;border-radius:8px;padding:2px 8px;'>[")
            .append(escapeHtml(label))
            .append("] ")
            .append(escaped)
            .append("</span></div>")
    }

    private fun escapeHtml(s: String): String =
        s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", "<br>")

    private fun streamText(chunk: String) {
        SwingUtilities.invokeLater {
            if (!streaming) {
                streaming = true
                streamBuffer.clear()
                chatBody.append("<table width='100%' cellpadding='0' cellspacing='0' border='0'><tr><td><div style='background:#ffffff;border:1px solid #e3e7ef;border-radius:12px 12px 12px 2px;padding:8px 12px;max-width:85%;display:inline-block;margin:4px 0;'>")
            }
            streamBuffer.append(chunk)
            renderChat()
        }
    }

    private fun flushStream() {
        if (!streaming) return
        streaming = false
        chatBody.append(escapeHtml(streamBuffer.toString())).append("</div></td></tr></table>")
        streamBuffer.clear()
    }

    private fun renderChat() {
        val content = if (streaming) {
            "${chatBody}${escapeHtml(streamBuffer.toString())}"
        } else {
            chatBody.toString()
        }
        chatOutput.text = "<html><body style='background:#f5f6fa;font-family:Segoe UI,Tahoma,sans-serif;font-size:13px;'>$content</body></html>"
    }

    fun onSidecarConnected(version: String) {
        SwingUtilities.invokeLater {
            statusLabel.text = "sidecar: connected"
            versionLabel.text = "extension $version"
            startButton.isEnabled = false
            stopButton.isEnabled = true
            refreshProviders()
            refreshChatModels()
            loadChatModelSelection()
            loadProviderSettings()
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
                when (type) {
                    "text" -> {
                        val data = params.get("data")?.takeIf { !it.isJsonNull }?.asString ?: ""
                        streamText(data)
                    }
                    "error" -> {
                        val data = params.get("data")?.takeIf { !it.isJsonNull }?.toString() ?: ""
                        appendChat("agent", "error", data)
                    }
                    "done" -> SwingUtilities.invokeLater { flushStream() }
                    else -> {
                        val data = params.get("data")?.takeIf { !it.isJsonNull }?.toString() ?: ""
                        appendChat("agent", type, data)
                    }
                }
            }
            "auth.status.changed" -> SwingUtilities.invokeLater { renderProviders(params) }
            "approval.requested" -> promptApproval(params)
            "tool.call" -> {
                val name = params.get("toolCall")?.takeIf { !it.isJsonNull && it.isJsonObject }?.asJsonObject?.get("name")?.asString ?: "?"
                appendChat("tool", "tool", name)
                conversation.append("TOOL_CALL: ").append(name).append('\n')
            }
            "run.progress" -> {
                val msg = params.get("message")?.takeIf { !it.isJsonNull }?.asString ?: ""
                val done = params.get("done")?.asBoolean == true
                if (done) {
                    SwingUtilities.invokeLater { flushStream() }
                    conversation.append("RUN: ").append(msg).append('\n')
                    if (msg.isNotEmpty() && !msg.startsWith("error")) appendChat("run", "done", msg)
                    else if (msg.startsWith("error")) appendChat("run", "error", msg)
                } else if (msg.isNotEmpty()) {
                    appendChat("run", "done", msg)
                }
            }
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
