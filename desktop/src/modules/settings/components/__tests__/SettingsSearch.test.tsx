import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SettingsSearch from '../SettingsSearch'

// ── Hoisted mocks (vi.hoisted avoids temporal-dead-zone in vi.mock factories) ──

const mocks = vi.hoisted(() => ({
  setViewMode: vi.fn(),
  setShowSettings: vi.fn(),
  setSettingsInitialTab: vi.fn(),
  applyTheme: vi.fn(),
  applyThemeAndNotify: vi.fn(),
  saveThemeId: vi.fn(),
  saveMode: vi.fn(),
  setApiKey: vi.fn().mockResolvedValue(undefined),
  getConfig: vi.fn().mockReturnValue({ mcpServers: [], model: { apiKeys: {} }, behavior: {}, sandbox: {} }),
  saveConfig: vi.fn(),
}))

vi.mock('@/store/uiStore', () => ({
  useUiStore: (sel: any) => {
    const state = { setViewMode: mocks.setViewMode, setShowSettings: mocks.setShowSettings, setSettingsInitialTab: mocks.setSettingsInitialTab }
    return sel ? sel(state) : state
  },
}))

vi.mock('@/lib/themes', () => ({
  THEMES: [
    {
      id: 'betopia', name: 'Betopia', description: 'Default dark', preview: ['#0a0a0b', '#da7756', '#141416'],
      dark:  { bg: '#0a0a0b', surface: '#141416', surface2: '', surface3: '', border: '', border2: '', text: '', text2: '', text3: '', accent: '',       accentBg: '', accentHover: '', codeBg: '', red: '' },
      light: { bg: '#f6f7fb', surface: '#ffffff',  surface2: '', surface3: '', border: '', border2: '', text: '', text2: '', text3: '', accent: '#0066cc', accentBg: '', accentHover: '', codeBg: '', red: '' },
    },
    {
      id: 'nord', name: 'Nord', description: 'Arctic theme', preview: ['#2e3440', '#88c0d0', '#3b4252'],
      dark: { bg: '#2e3440', surface: '#3b4252', surface2: '', surface3: '', border: '', border2: '', text: '', text2: '', text3: '', accent: '', accentBg: '', accentHover: '', codeBg: '', red: '' },
    },
  ],
  getSavedThemeId: () => 'betopia',
  getSavedMode:    () => 'dark',
  applyTheme:          mocks.applyTheme,
  applyThemeAndNotify: mocks.applyThemeAndNotify,
  saveThemeId:         mocks.saveThemeId,
  saveMode:            mocks.saveMode,
}))

vi.mock('@/lib/config', () => ({
  setApiKey:  (...args: any[]) => mocks.setApiKey(...args),
  getConfig:  () => mocks.getConfig(),
  saveConfig: (...args: any[]) => mocks.saveConfig(...args),
}))

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('SettingsSearch', () => {
  const onClose = vi.fn()

  beforeEach(() => { vi.clearAllMocks() })

  // ── Basic render ──

  it('renders search input', () => {
    render(<SettingsSearch onClose={onClose} />)
    expect(screen.getByTestId('ss-input')).toBeInTheDocument()
  })

  it('shows results by default', () => {
    render(<SettingsSearch onClose={onClose} />)
    expect(screen.getByTestId('ss-results')).toBeInTheDocument()
    // Theme items are hidden in the default (empty query) view — they appear via search or theme-picker sub-page
    expect(screen.queryByTestId('ss-group-Theme')).not.toBeInTheDocument()
  })

  it('filters by fuzzy search', async () => {
    render(<SettingsSearch onClose={onClose} />)
    await userEvent.type(screen.getByTestId('ss-input'), 'nord')
    expect(screen.getByText('Nord — Dark')).toBeInTheDocument()
  })

  it('shows empty state for unmatched query', async () => {
    render(<SettingsSearch onClose={onClose} />)
    await userEvent.type(screen.getByTestId('ss-input'), 'zzzzzzz')
    await waitFor(() => expect(screen.queryByTestId('ss-empty')).toBeInTheDocument())
  })

  // ── Close behavior ──

  it('closes on overlay click', () => {
    render(<SettingsSearch onClose={onClose} />)
    fireEvent.click(screen.getByTestId('ss-overlay'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close on modal click', () => {
    render(<SettingsSearch onClose={onClose} />)
    fireEvent.click(screen.getByTestId('ss-modal'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape', () => {
    render(<SettingsSearch onClose={onClose} />)
    fireEvent.keyDown(screen.getByTestId('ss-modal'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clears query on clear button', async () => {
    render(<SettingsSearch onClose={onClose} />)
    const input = screen.getByTestId('ss-input') as HTMLInputElement
    await userEvent.type(input, 'nord')
    fireEvent.click(screen.getByTestId('ss-clear'))
    expect(input.value).toBe('')
  })

  // ── Regular item actions ──

  it('applies theme on item click', async () => {
    render(<SettingsSearch onClose={onClose} />)
    await userEvent.type(screen.getByTestId('ss-input'), 'nord')
    fireEvent.click(screen.getByTestId('ss-item-theme.nord.dark'))
    expect(mocks.saveThemeId).toHaveBeenCalledWith('nord')
    expect(mocks.saveMode).toHaveBeenCalledWith('dark')
    expect(mocks.applyThemeAndNotify).toHaveBeenCalledWith('nord', 'dark')
    expect(onClose).toHaveBeenCalled()
  })

  it('switches view on view item click', () => {
    render(<SettingsSearch onClose={onClose} />)
    fireEvent.click(screen.getByTestId('ss-item-view.terminal'))
    expect(mocks.setViewMode).toHaveBeenCalledWith('terminal')
    expect(onClose).toHaveBeenCalled()
  })

  it('opens agent settings on settings item click', () => {
    render(<SettingsSearch onClose={onClose} />)
    fireEvent.click(screen.getByTestId('ss-item-settings.agent'))
    expect(mocks.setShowSettings).toHaveBeenCalledWith(true)
    expect(onClose).toHaveBeenCalled()
  })

  it('shows active indicator on current theme', async () => {
    render(<SettingsSearch onClose={onClose} />)
    await userEvent.type(screen.getByTestId('ss-input'), 'betopia')
    const item = screen.getByTestId('ss-item-theme.betopia.dark')
    expect(item.querySelector('.ss-active-dot')).toBeInTheDocument()
  })

  // ── Command (agentic) ──

  it('shows command section for "change theme to nord dark"', async () => {
    render(<SettingsSearch onClose={onClose} />)
    await userEvent.type(screen.getByTestId('ss-input'), 'change theme to nord dark')
    await waitFor(() => expect(screen.getByTestId('ss-command-section')).toBeInTheDocument())
    expect(screen.getByTestId('ss-command-item')).toBeInTheDocument()
  })

  it('does not show command section for plain search like "nord"', async () => {
    render(<SettingsSearch onClose={onClose} />)
    await userEvent.type(screen.getByTestId('ss-input'), 'nord')
    expect(screen.queryByTestId('ss-command-section')).not.toBeInTheDocument()
  })

  it('executes theme command when command item clicked', async () => {
    render(<SettingsSearch onClose={onClose} />)
    await userEvent.type(screen.getByTestId('ss-input'), 'change theme to nord dark')
    await waitFor(() => screen.getByTestId('ss-command-item'))
    fireEvent.click(screen.getByTestId('ss-command-item'))
    expect(mocks.saveThemeId).toHaveBeenCalledWith('nord')
    expect(mocks.saveMode).toHaveBeenCalledWith('dark')
    expect(mocks.applyThemeAndNotify).toHaveBeenCalledWith('nord', 'dark')
    expect(onClose).toHaveBeenCalled()
  })

  it('shows command section for MCP URL', async () => {
    render(<SettingsSearch onClose={onClose} />)
    await userEvent.type(screen.getByTestId('ss-input'), 'add mcp https://myserver.com/mcp')
    await waitFor(() => expect(screen.getByTestId('ss-command-section')).toBeInTheDocument())
    expect(screen.getByTestId('ss-command-item').textContent).toMatch(/MCP/)
  })

  it('saves MCP server on command click', async () => {
    render(<SettingsSearch onClose={onClose} />)
    await userEvent.type(screen.getByTestId('ss-input'), 'add mcp https://myserver.com/mcp')
    await waitFor(() => screen.getByTestId('ss-command-item'))
    fireEvent.click(screen.getByTestId('ss-command-item'))
    expect(mocks.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServers: expect.arrayContaining([
          expect.objectContaining({ url: 'https://myserver.com/mcp', type: 'http' }),
        ]),
      }),
    )
  })

  it('shows command for API key with sk- pattern', async () => {
    render(<SettingsSearch onClose={onClose} />)
    await userEvent.type(screen.getByTestId('ss-input'), 'set openai api key sk-abcdefghijklmnopqrstuvwxyz1234')
    await waitFor(() => expect(screen.getByTestId('ss-command-section')).toBeInTheDocument())
    expect(screen.getByTestId('ss-command-item').textContent).toMatch(/OpenAI/i)
  })

  it('saves API key on command click', async () => {
    render(<SettingsSearch onClose={onClose} />)
    await userEvent.type(screen.getByTestId('ss-input'), 'set openai api key sk-abcdefghijklmnopqrstuvwxyz1234')
    await waitFor(() => screen.getByTestId('ss-command-item'))
    fireEvent.click(screen.getByTestId('ss-command-item'))
    await waitFor(() => expect(mocks.setApiKey).toHaveBeenCalledWith('openai', expect.stringContaining('sk-')))
  })

  it('Enter key executes command when command is selected', async () => {
    render(<SettingsSearch onClose={onClose} />)
    await userEvent.type(screen.getByTestId('ss-input'), 'change theme to nord dark')
    await waitFor(() => screen.getByTestId('ss-command-item'))
    fireEvent.keyDown(screen.getByTestId('ss-modal'), { key: 'Enter' })
    expect(mocks.saveThemeId).toHaveBeenCalledWith('nord')
  })

  it('shows view command for "go to terminal"', async () => {
    render(<SettingsSearch onClose={onClose} />)
    await userEvent.type(screen.getByTestId('ss-input'), 'go to terminal')
    await waitFor(() => expect(screen.getByTestId('ss-command-section')).toBeInTheDocument())
    expect(screen.getByTestId('ss-command-item').textContent).toMatch(/terminal/i)
  })

  it('executes view command and switches view', async () => {
    render(<SettingsSearch onClose={onClose} />)
    await userEvent.type(screen.getByTestId('ss-input'), 'go to terminal')
    await waitFor(() => screen.getByTestId('ss-command-item'))
    fireEvent.click(screen.getByTestId('ss-command-item'))
    expect(mocks.setViewMode).toHaveBeenCalledWith('terminal')
    expect(onClose).toHaveBeenCalled()
  })
})
