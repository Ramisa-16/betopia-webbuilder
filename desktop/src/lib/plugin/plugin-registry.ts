import type { ToolDefinition, PanelDefinition, SlashCommand, Keybinding, ThemeDefinition, AgentDefinition, SubagentDefinition, ProviderDefinition } from './plugin-api'

interface RegisteredTool {
  pluginId: string
  definition: ToolDefinition
}

interface RegisteredPanel {
  pluginId: string
  definition: PanelDefinition
}

interface RegisteredCommand {
  pluginId: string
  definition: SlashCommand
}

interface RegisteredKeybinding {
  pluginId: string
  definition: Keybinding
}

interface RegisteredTheme {
  pluginId: string
  definition: ThemeDefinition
}

interface RegisteredAgent {
  pluginId: string
  definition: AgentDefinition
}

interface RegisteredSubagent {
  pluginId: string
  definition: SubagentDefinition
}

interface RegisteredProvider {
  pluginId: string
  definition: ProviderDefinition
}

export class PluginRegistry {
  private tools = new Map<string, RegisteredTool>()
  private panels = new Map<string, RegisteredPanel>()
  private commands = new Map<string, RegisteredCommand>()
  private keybindings = new Map<string, RegisteredKeybinding>()
  private themes = new Map<string, RegisteredTheme>()
  private agents = new Map<string, RegisteredAgent>()
  private subagents = new Map<string, RegisteredSubagent>()
  private providers = new Map<string, RegisteredProvider>()

  // ── Tool registration ──────────────────────────────────────────────────────

  registerTool(pluginId: string, tool: ToolDefinition): () => void {
    const prefixedName = tool.globalName ? tool.name : `${pluginId}__${tool.name}`
    if (this.tools.has(prefixedName)) {
      console.warn(`[plugin] Tool "${prefixedName}" already registered, overwriting`)
    }
    this.tools.set(prefixedName, { pluginId, definition: tool })
    return () => this.tools.delete(prefixedName)
  }

  unregisterTool(name: string): void {
    this.tools.delete(name)
  }

  getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name)
  }

  getAllTools(): RegisteredTool[] {
    return Array.from(this.tools.values())
  }

  removeToolsForPlugin(pluginId: string): void {
    for (const [name, t] of this.tools) {
      if (t.pluginId === pluginId) this.tools.delete(name)
    }
  }

  // ── Panel registration ─────────────────────────────────────────────────────

  registerPanel(pluginId: string, panel: PanelDefinition): () => void {
    this.panels.set(panel.id, { pluginId, definition: panel })
    return () => this.panels.delete(panel.id)
  }

  getAllPanels(): RegisteredPanel[] {
    return Array.from(this.panels.values())
  }

  removePanelsForPlugin(pluginId: string): void {
    for (const [id, p] of this.panels) {
      if (p.pluginId === pluginId) this.panels.delete(id)
    }
  }

  // ── Command registration ───────────────────────────────────────────────────

  registerCommand(pluginId: string, cmd: SlashCommand): () => void {
    this.commands.set(cmd.id, { pluginId, definition: cmd })
    return () => this.commands.delete(cmd.id)
  }

  getAllCommands(): RegisteredCommand[] {
    return Array.from(this.commands.values())
  }

  removeCommandsForPlugin(pluginId: string): void {
    for (const [id, c] of this.commands) {
      if (c.pluginId === pluginId) this.commands.delete(id)
    }
  }

  // ── Keybinding registration ────────────────────────────────────────────────

  registerKeybinding(pluginId: string, kb: Keybinding): () => void {
    this.keybindings.set(`${pluginId}:${kb.key}`, { pluginId, definition: kb })
    return () => this.keybindings.delete(`${pluginId}:${kb.key}`)
  }

  getAllKeybindings(): RegisteredKeybinding[] {
    return Array.from(this.keybindings.values())
  }

  removeKeybindingsForPlugin(pluginId: string): void {
    for (const [key, k] of this.keybindings) {
      if (k.pluginId === pluginId) this.keybindings.delete(key)
    }
  }

  // ── Theme registration ─────────────────────────────────────────────────────

  registerTheme(pluginId: string, theme: ThemeDefinition): () => void {
    this.themes.set(theme.id, { pluginId, definition: theme })
    return () => this.themes.delete(theme.id)
  }

  getAllThemes(): RegisteredTheme[] {
    return Array.from(this.themes.values())
  }

  removeThemesForPlugin(pluginId: string): void {
    for (const [id, t] of this.themes) {
      if (t.pluginId === pluginId) this.themes.delete(id)
    }
  }

  // ── Agent registration ─────────────────────────────────────────────────────

  registerAgent(pluginId: string, agent: AgentDefinition): () => void {
    const prefixedId = `plugin:${pluginId}:${agent.id}`
    this.agents.set(prefixedId, { pluginId, definition: agent })
    return () => this.agents.delete(prefixedId)
  }

  getAllAgents(): RegisteredAgent[] {
    return Array.from(this.agents.values())
  }

  // ── Subagent registration ──────────────────────────────────────────────────

  registerSubagent(pluginId: string, subagent: SubagentDefinition): () => void {
    this.subagents.set(subagent.id, { pluginId, definition: subagent })
    return () => this.subagents.delete(subagent.id)
  }

  getAllSubagents(): RegisteredSubagent[] {
    return Array.from(this.subagents.values())
  }

  // ── Provider registration ──────────────────────────────────────────────────

  registerProvider(pluginId: string, provider: ProviderDefinition): () => void {
    this.providers.set(provider.id, { pluginId, definition: provider })
    return () => this.providers.delete(provider.id)
  }

  getAllProviders(): RegisteredProvider[] {
    return Array.from(this.providers.values())
  }

  // ── Bulk cleanup ────────────────────────────────────────────────────────────

  removeAllForPlugin(pluginId: string): void {
    this.removeToolsForPlugin(pluginId)
    this.removePanelsForPlugin(pluginId)
    this.removeCommandsForPlugin(pluginId)
    this.removeKeybindingsForPlugin(pluginId)
    this.removeThemesForPlugin(pluginId)
  }
}
