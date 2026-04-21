import { useEffect, useMemo, useRef, useState } from 'react'
import { sessionsApi } from '../../api/sessions'
import { useChatStore } from '../../stores/chatStore'
import { useMcpStore } from '../../stores/mcpStore'
import { usePluginStore } from '../../stores/pluginStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useSkillStore } from '../../stores/skillStore'
import { useTranslation } from '../../i18n'
import { MessageList } from '../chat/MessageList'
import { ComputerUsePermissionModal } from '../chat/ComputerUsePermissionModal'
import { Button } from '../shared/Button'
import { Textarea } from '../shared/Textarea'
import { DirectoryPicker } from '../shared/DirectoryPicker'
import { useUIStore } from '../../stores/uiStore'
import { buildInstallerPrompt } from '../../lib/installAssistantPrompt'

const INSTALLER_SESSION_KEY = 'cc-haha-installer-session-id'
const INSTALLER_CONTEXT_KEY = 'cc-haha-installer-context-dir'

const EXAMPLE_PROMPTS = [
  '安装 plugin：skill-creator@claude-plugins-official，并应用到当前桌面端',
  '添加一个 MCP：name=linear，url=https://example.com/mcp，优先用户级',
  '帮我把一个 GitHub 仓库里的 skill 装到 ~/.claude/skills，并告诉我装到了哪里',
]

function readStoredValue(key: string) {
  try {
    return localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

function writeStoredValue(key: string, value: string) {
  try {
    if (value) {
      localStorage.setItem(key, value)
    } else {
      localStorage.removeItem(key)
    }
  } catch {
    // noop
  }
}

export function InstallCenter() {
  const t = useTranslation()
  const sessions = useSessionStore((s) => s.sessions)
  const fetchSessions = useSessionStore((s) => s.fetchSessions)
  const connectToSession = useChatStore((s) => s.connectToSession)
  const disconnectSession = useChatStore((s) => s.disconnectSession)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const stopGeneration = useChatStore((s) => s.stopGeneration)
  const fetchPlugins = usePluginStore((s) => s.fetchPlugins)
  const reloadPlugins = usePluginStore((s) => s.reloadPlugins)
  const fetchSkills = useSkillStore((s) => s.fetchSkills)
  const fetchServers = useMcpStore((s) => s.fetchServers)
  const addToast = useUIStore((s) => s.addToast)
  const setPendingSettingsTab = useUIStore((s) => s.setPendingSettingsTab)

  const [sessionId, setSessionId] = useState<string | null>(() => {
    const stored = readStoredValue(INSTALLER_SESSION_KEY)
    return stored || null
  })
  const [contextDir, setContextDir] = useState(() => readStoredValue(INSTALLER_CONTEXT_KEY))
  const [draft, setDraft] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const createPromiseRef = useRef<Promise<string> | null>(null)
  const previousChatStateRef = useRef<'idle' | 'thinking' | 'tool_executing' | 'streaming' | 'permission_pending'>('idle')

  const installerSession = useMemo(
    () => sessions.find((session) => session.id === sessionId) || null,
    [sessionId, sessions],
  )
  const sessionState = useChatStore((s) =>
    sessionId ? s.sessions[sessionId] : undefined,
  )
  const chatState = sessionState?.chatState ?? 'idle'
  const pendingComputerUsePermission =
    sessionState?.pendingComputerUsePermission?.request ?? null
  const isBusy = isCreating || chatState !== 'idle'

  useEffect(() => {
    if (!sessionId) return
    connectToSession(sessionId)
    return () => {
      disconnectSession(sessionId)
    }
  }, [connectToSession, disconnectSession, sessionId])

  useEffect(() => {
    writeStoredValue(INSTALLER_CONTEXT_KEY, contextDir.trim())
  }, [contextDir])

  useEffect(() => {
    if (!sessionId) return
    const previousState = previousChatStateRef.current
    previousChatStateRef.current = chatState

    if (previousState === 'idle' || chatState !== 'idle') return

    const cwd = installerSession?.workDir || undefined

    void (async () => {
      await reloadPlugins(cwd).catch(() => null)
      await Promise.allSettled([
        fetchPlugins(cwd),
        fetchSkills(cwd),
        fetchServers(cwd ? [cwd] : undefined, cwd),
      ])
    })()
  }, [
    chatState,
    fetchPlugins,
    fetchServers,
    fetchSkills,
    installerSession?.workDir,
    reloadPlugins,
    sessionId,
  ])

  const ensureInstallerSession = async () => {
    if (sessionId && installerSession) {
      return sessionId
    }

    if (createPromiseRef.current) {
      return createPromiseRef.current
    }

    setIsCreating(true)
    createPromiseRef.current = (async () => {
      const { sessionId: createdSessionId } = await sessionsApi.create(
        contextDir.trim() || undefined,
      )
      await sessionsApi.rename(
        createdSessionId,
        t('settings.install.sessionTitle'),
      )
      writeStoredValue(INSTALLER_SESSION_KEY, createdSessionId)
      setSessionId(createdSessionId)
      await fetchSessions()
      connectToSession(createdSessionId)
      return createdSessionId
    })()

    try {
      return await createPromiseRef.current
    } finally {
      createPromiseRef.current = null
      setIsCreating(false)
    }
  }

  const handleSubmit = async () => {
    const request = draft.trim()
    if (!request || isBusy) return

    try {
      const ensuredSessionId = await ensureInstallerSession()
      sendMessage(
        ensuredSessionId,
        buildInstallerPrompt(request),
        undefined,
        { displayContent: request },
      )
      setDraft('')
    } catch (error) {
      addToast({
        type: 'error',
        message:
          error instanceof Error
            ? error.message
            : t('settings.install.createFailed'),
      })
    }
  }

  const handleRefresh = async () => {
    const cwd = installerSession?.workDir || undefined
    await Promise.all([
      fetchPlugins(cwd),
      fetchSkills(cwd),
      fetchServers(cwd ? [cwd] : undefined, cwd),
    ])
    addToast({
      type: 'success',
      message: t('settings.install.refreshDone'),
    })
  }

  const startFreshConversation = async () => {
    if (sessionId) {
      disconnectSession(sessionId)
    }
    writeStoredValue(INSTALLER_SESSION_KEY, '')
    setSessionId(null)
    previousChatStateRef.current = 'idle'
    addToast({
      type: 'info',
      message: t('settings.install.newConversationReady'),
    })
  }

  return (
    <div className="w-full min-w-0">
      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] overflow-hidden">
        <div className="grid gap-4 px-5 py-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(280px,1fr)] xl:items-start">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-tertiary)] mb-2">
              {t('settings.install.eyebrow')}
            </div>
            <div className="flex items-center gap-3 mb-2">
              <span className="material-symbols-outlined text-[22px] text-[var(--color-brand)]">
                download
              </span>
              <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">
                {t('settings.install.title')}
              </h2>
            </div>
            <p className="text-sm leading-6 text-[var(--color-text-secondary)] max-w-3xl">
              {t('settings.install.description')}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-2">
            <SummaryPill
              label={t('settings.install.targets.plugins')}
              icon="extension"
            />
            <SummaryPill
              label={t('settings.install.targets.mcp')}
              icon="hub"
            />
            <SummaryPill
              label={t('settings.install.targets.skills')}
              icon="auto_awesome"
            />
            <SummaryPill
              label={installerSession?.workDir || t('settings.install.contextAuto')}
              icon="folder"
            />
          </div>
        </div>
      </section>

      <section className="mt-6 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
              {t('settings.install.composeTitle')}
            </h3>
            <p className="text-xs text-[var(--color-text-tertiary)] mt-1">
              {t('settings.install.composeHint')}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void handleRefresh()}
            >
              {t('settings.install.refresh')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void startFreshConversation()}
            >
              {t('settings.install.newConversation')}
            </Button>
          </div>
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault()
                  void handleSubmit()
                }
              }}
              placeholder={t('settings.install.placeholder')}
              className="min-h-[140px]"
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {EXAMPLE_PROMPTS.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setDraft(example)}
                  className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
                >
                  {example}
                </button>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {chatState !== 'idle' && sessionId ? (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => stopGeneration(sessionId)}
                >
                  {t('settings.install.stop')}
                </Button>
              ) : null}
              <Button
                size="sm"
                onClick={() => void handleSubmit()}
                loading={isCreating}
                disabled={!draft.trim() || isBusy}
                icon={
                  !isCreating ? (
                    <span className="material-symbols-outlined text-[16px]">send</span>
                  ) : undefined
                }
              >
                {t('settings.install.send')}
              </Button>
              <span className="text-xs text-[var(--color-text-tertiary)]">
                {installerSession?.workDir
                  ? t('settings.install.contextUsing', {
                      path: installerSession.workDir,
                    })
                  : t('settings.install.contextDefault')}
              </span>
            </div>
          </div>

          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
              {t('settings.install.contextTitle')}
            </div>
            <p className="mt-2 text-xs leading-5 text-[var(--color-text-tertiary)]">
              {t('settings.install.contextHint')}
            </p>
            <div className="mt-3">
              <DirectoryPicker value={contextDir} onChange={setContextDir} />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPendingSettingsTab('plugins')}
              >
                {t('settings.install.goPlugins')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPendingSettingsTab('mcp')}
              >
                {t('settings.install.goMcp')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPendingSettingsTab('skills')}
              >
                {t('settings.install.goSkills')}
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section className="mt-6 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
              {t('settings.install.sessionTitle')}
            </h3>
            <p className="text-xs text-[var(--color-text-tertiary)] mt-1">
              {sessionId
                ? t('settings.install.sessionHint')
                : t('settings.install.sessionEmpty')}
            </p>
          </div>
          {sessionId ? (
            <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              {chatState}
            </span>
          ) : null}
        </div>

        <div className="min-h-[420px] bg-[var(--color-surface-container-lowest)]">
          {sessionId ? (
            <>
              <MessageList sessionId={sessionId} />
              <ComputerUsePermissionModal
                sessionId={sessionId}
                request={pendingComputerUsePermission}
              />
            </>
          ) : (
            <div className="flex h-[420px] flex-col items-center justify-center px-6 text-center">
              <span className="material-symbols-outlined text-[36px] text-[var(--color-text-tertiary)] mb-3">
                forum
              </span>
              <p className="text-sm text-[var(--color-text-secondary)]">
                {t('settings.install.sessionEmpty')}
              </p>
              <p className="mt-2 max-w-md text-xs leading-6 text-[var(--color-text-tertiary)]">
                {t('settings.install.sessionEmptyHint')}
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function SummaryPill({
  label,
  icon,
}: {
  label: string
  icon: string
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3 min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)] min-w-0">
        <span className="material-symbols-outlined text-[14px] flex-shrink-0">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
    </div>
  )
}
