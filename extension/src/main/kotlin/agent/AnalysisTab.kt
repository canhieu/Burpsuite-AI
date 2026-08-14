package agent

import com.google.gson.JsonObject
import java.awt.BorderLayout
import java.awt.Color
import java.awt.FlowLayout
import java.awt.Font
import java.text.SimpleDateFormat
import java.util.Date
import javax.swing.BorderFactory
import javax.swing.JButton
import javax.swing.JCheckBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JSlider
import javax.swing.JSplitPane
import javax.swing.JTable
import javax.swing.JTextArea
import javax.swing.SwingUtilities
import javax.swing.table.AbstractTableModel
import javax.swing.table.DefaultTableCellRenderer

data class AnalysisEntry(
    val time: Long,
    val method: String,
    val url: String,
    val status: Int,
    val score: Int,
    val flags: List<String>,
    val level: String?,     // from LLM when available
    val vulnClass: String?,
    val confidence: Int?,
    val summary: String?,
    val nextStep: String?,
)

class AnalysisTab(private val ctx: AgentContext) {

    private val entries = ArrayList<AnalysisEntry>()
    private val model = AnalysisTableModel(entries)
    private val table = JTable(model)
    private val detail = JTextArea(12, 90)
    private val enableAnalysis = JCheckBox("Auto-analyze proxy traffic", true)
    private val enableLlm = JCheckBox("LLM deep analysis", true)
    private val thresholdSlider = JSlider(1, 20, ctx.analysis.threshold)
    private val thresholdLabel = JLabel("threshold: ${ctx.analysis.threshold}")

    private val timeFmt = SimpleDateFormat("HH:mm:ss")

    init {
        enableAnalysis.addActionListener { ctx.analysis.enabled = enableAnalysis.isSelected }
        enableLlm.addActionListener { ctx.analysis.llmEnabled = enableLlm.isSelected }
        thresholdSlider.addChangeListener {
            ctx.analysis.threshold = thresholdSlider.value
            thresholdLabel.text = "threshold: ${thresholdSlider.value}"
        }
    }

    fun component(): JComponent {
        table.autoCreateRowSorter = true
        table.fillsViewportHeight = true
        table.setDefaultRenderer(String::class.java, SeverityCellRenderer())
        table.setDefaultRenderer(Integer::class.java, SeverityCellRenderer())
        table.selectionModel.addListSelectionListener {
            val idx = table.selectedRow
            if (idx >= 0) showDetail(model.entries[table.convertRowIndexToModel(idx)])
        }

        detail.isEditable = false
        detail.font = Font(Font.MONOSPACED, Font.PLAIN, 12)
        detail.background = Color(250, 250, 252)

        val toggles = JPanel(FlowLayout(FlowLayout.LEFT, 14, 6))
        toggles.add(enableAnalysis)
        toggles.add(enableLlm)
        toggles.add(thresholdLabel)
        toggles.add(thresholdSlider)
        val clear = JButton("Clear")
        clear.addActionListener {
            model.entries.clear()
            model.fireTableDataChanged()
            detail.text = ""
        }
        toggles.add(clear)
        toggles.border = BorderFactory.createEmptyBorder(4, 8, 4, 8)

        val split = JSplitPane(JSplitPane.VERTICAL_SPLIT, JScrollPane(table), JScrollPane(detail))
        split.resizeWeight = 0.65
        split.setContinuousLayout(true)
        split.dividerLocation = 320

        val panel = JPanel(BorderLayout())
        panel.add(toggles, BorderLayout.NORTH)
        panel.add(split, BorderLayout.CENTER)
        return panel
    }

    private fun showDetail(e: AnalysisEntry) {
        val sb = StringBuilder()
        sb.append("Time   : ").append(timeFmt.format(Date(e.time))).append('\n')
        sb.append("Method : ").append(e.method).append('\n')
        sb.append("URL    : ").append(e.url).append('\n')
        sb.append("Status : ").append(e.status).append("   score: ").append(e.score).append('\n')
        if (e.flags.isNotEmpty()) sb.append("Flags  : ").append(e.flags.joinToString(", ")).append('\n')
        if (e.level != null) sb.append("LLM    : [").append(e.level.uppercase()).append("] ")
            .append(e.vulnClass ?: "?").append(" (confidence ").append(e.confidence ?: 0).append("%)\n")
        if (e.summary != null) sb.append("Summary: ").append(e.summary).append('\n')
        if (e.nextStep != null) sb.append("\nNext step:\n").append(e.nextStep).append('\n')
        detail.text = sb.toString()
        detail.caretPosition = 0
    }

    /** Heuristic-only info entry (no LLM yet). */
    fun addSignal(bundle: SignalBundle) {
        SwingUtilities.invokeLater {
            model.entries.add(0, AnalysisEntry(
                time = bundle.time,
                method = bundle.method,
                url = bundle.url,
                status = bundle.status,
                score = bundle.score,
                flags = bundle.flags,
                level = null, vulnClass = null, confidence = null, summary = null, nextStep = null,
            ))
            while (model.entries.size > 500) model.entries.removeAt(model.entries.size - 1)
            model.fireTableDataChanged()
        }
    }

    /** LLM result arrives from sidecar. */
    fun onEntry(params: JsonObject) {
        SwingUtilities.invokeLater {
            val url = params.get("url")?.asString ?: return@invokeLater
            val level = params.get("level")?.takeIf { !it.isJsonNull }?.asString
            val existing = model.entries.firstOrNull { it.url == url && it.level == null }
            if (existing != null) {
                val idx = model.entries.indexOf(existing)
                model.entries[idx] = existing.copy(
                    level = level,
                    vulnClass = params.get("vulnClass")?.takeIf { !it.isJsonNull }?.asString,
                    confidence = params.get("confidence")?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asInt,
                    summary = params.get("summary")?.takeIf { !it.isJsonNull }?.asString,
                    nextStep = params.get("nextStep")?.takeIf { !it.isJsonNull }?.asString,
                )
            } else {
                model.entries.add(0, AnalysisEntry(
                    time = System.currentTimeMillis(),
                    method = params.get("method")?.asString ?: "",
                    url = url,
                    status = params.get("status")?.asInt ?: 0,
                    score = params.get("score")?.asInt ?: 0,
                    flags = emptyList(),
                    level = level,
                    vulnClass = params.get("vulnClass")?.takeIf { !it.isJsonNull }?.asString,
                    confidence = params.get("confidence")?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asInt,
                    summary = params.get("summary")?.takeIf { !it.isJsonNull }?.asString,
                    nextStep = params.get("nextStep")?.takeIf { !it.isJsonNull }?.asString,
                ))
            }
            while (model.entries.size > 500) model.entries.removeAt(model.entries.size - 1)
            model.fireTableDataChanged()
        }
    }
}

class AnalysisTableModel(val entries: MutableList<AnalysisEntry>) : AbstractTableModel() {
    private val columns = arrayOf("Time", "Method", "URL", "Status", "Score", "Severity", "Class", "Summary")
    override fun getRowCount() = entries.size
    override fun getColumnCount() = columns.size
    override fun getColumnName(c: Int) = columns[c]
    override fun getValueAt(r: Int, c: Int): Any? = when (c) {
        0 -> entries[r].time
        1 -> entries[r].method
        2 -> entries[r].url
        3 -> entries[r].status
        4 -> entries[r].score
        5 -> entries[r].level ?: ""
        6 -> entries[r].vulnClass ?: ""
        7 -> entries[r].summary ?: entries[r].flags.joinToString(",")
        else -> null
    }
}

class SeverityCellRenderer : DefaultTableCellRenderer() {
    override fun getTableCellRendererComponent(
        table: JTable, value: Any?, isSelected: Boolean, hasFocus: Boolean, row: Int, column: Int,
    ): java.awt.Component {
        val c = super.getTableCellRendererComponent(table, value, isSelected, hasFocus, row, column)
        val model = table.model as AnalysisTableModel
        val entry = model.entries[table.convertRowIndexToModel(row)]
        val level = entry.level
        foreground = when {
            level == "critical" -> Color(180, 0, 0)
            level == "high" -> Color(200, 90, 0)
            level == "medium" -> Color(160, 120, 0)
            level == "low" -> Color(0, 120, 160)
            entry.score >= 6 -> Color(120, 60, 160)
            else -> Color(90, 96, 108)
        }
        font = font.deriveFont(Font.BOLD)
        return c
    }
}
