package agent

import burp.api.montoya.ui.contextmenu.AuditIssueContextMenuEvent
import burp.api.montoya.ui.contextmenu.ContextMenuEvent
import burp.api.montoya.ui.contextmenu.ContextMenuItemsProvider
import burp.api.montoya.ui.contextmenu.WebSocketContextMenuEvent
import java.awt.event.ActionEvent
import javax.swing.JMenuItem

class ContextMenuProvider(private val ctx: AgentContext) : ContextMenuItemsProvider {

    override fun provideMenuItems(event: ContextMenuEvent): List<JMenuItem> {
        val items = ArrayList<JMenuItem>()
        val invocation = event.invocationType()
        if (invocation.containsHttpMessage()) {
            val editor = event.messageEditorRequestResponse().orElse(null)
            val selected = event.selectedRequestResponses()
            val rr = if (selected.isNotEmpty()) selected.first() else editor?.requestResponse()
            if (rr != null) {
                val source = if (invocation.name.contains("PROXY")) "proxy" else "agent"
                items.add(
                    menuItem("Agent > Ask about selection") {
                        ctx.selection.store(rr, invocation.name, source)
                        ctx.tab?.focusTab()
                    }
                )
                items.add(
                    menuItem("Agent > Analyze request/response") {
                        ctx.selection.store(rr, invocation.name, source)
                        ctx.tab?.focusTab()
                    }
                )
            }
        }
        return items
    }

    override fun provideMenuItems(event: WebSocketContextMenuEvent): List<JMenuItem> = emptyList()

    override fun provideMenuItems(event: AuditIssueContextMenuEvent): List<JMenuItem> = emptyList()

    private fun menuItem(label: String, action: () -> Unit): JMenuItem {
        val item = JMenuItem(label)
        item.addActionListener { e: ActionEvent -> action() }
        return item
    }
}
