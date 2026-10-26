import * as React from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FileState } from '../../shared/wire/state.ts'
import { subscribeUniverFileEvents } from '../api/univer-events.ts'
import {
  getFileState,
  getUniverStatus,
  isMissingUniverFile,
  startGateway
} from '../api/univer-api.ts'

/**
 * Poll collaboration state for a stable list of files, with WebSocket invalidation push as the
 * primary refresh path. The push channels (Gateway lifecycle events through the same-origin
 * tunnel) only announce that a file changed; the authoritative state is always re-pulled over the
 * session-scoped HTTP API. Polling runs exactly while the push channels are not all live, so the
 * two paths never duplicate requests. Push sockets stay open while the page is hidden; the pulls
 * they trigger are deferred until the page is visible again.
 */
export function useUniverStates(
  files: readonly string[],
  sessionId: SessionId,
  intervalMs = 900
): {
  readonly states: Readonly<Record<string, FileState>>
  readonly missingFiles: ReadonlySet<string>
  readonly applyState: (state: FileState) => void
} {
  const [states, setStates] = React.useState<Record<string, FileState>>({})
  const [missing, setMissing] = React.useState<Record<string, true>>({})
  const key = files.join('\u0000')
  React.useEffect(() => {
    if (key === '') {
      setStates({})
      setMissing({})
      return
    }
    const trackedFiles = key.split('\u0000')
    setStates({})
    setMissing({})
    let active = true
    let pushActive = false
    const inFlight = new Set<string>()
    const refetchQueued = new Set<string>()
    const deferredWhileHidden = new Set<string>()
    const subscriptions = new Map<string, ReturnType<typeof subscribeUniverFileEvents>>()
    const connections = new Map<string, boolean>()

    // Worktree unit events only ride the worktree channels, so follow the live worktrees of each
    // projection as they become known. Terminal worktrees emit no events, so they are not followed.
    const syncWorktreeChannels = (file: string, state: FileState | undefined): void => {
      const liveWorktreeIds =
        state === undefined
          ? []
          : state.worktrees
              .filter((worktree) => worktree.status === 'draft' || worktree.status === 'ready')
              .map((worktree) => worktree.worktreeId)
      subscriptions.get(file)?.setWorktrees(liveWorktreeIds)
    }

    const fetchFile = async (file: string): Promise<void> => {
      // Coalesce triggers that race an in-flight fetch instead of dropping them: push has no next
      // tick that could repair a lost notification.
      if (inFlight.has(file)) {
        refetchQueued.add(file)
        return
      }
      inFlight.add(file)
      try {
        const state = await getFileState(file, sessionId)
        if (!active) return
        setStates((previous) => ({ ...previous, [file]: state }))
        setMissing((previous) => {
          if (previous[file] === undefined) return previous
          const next = { ...previous }
          delete next[file]
          return next
        })
        syncWorktreeChannels(file, state)
      } catch (error) {
        if (!active) return
        if (isMissingUniverFile(error)) {
          setStates((previous) => {
            if (previous[file] === undefined) return previous
            const next = { ...previous }
            delete next[file]
            return next
          })
          setMissing((previous) =>
            previous[file] === true ? previous : { ...previous, [file]: true }
          )
          syncWorktreeChannels(file, undefined)
        }
      } finally {
        inFlight.delete(file)
        if (active && refetchQueued.delete(file)) void fetchFile(file)
      }
    }

    const poll = async (): Promise<void> => {
      for (const file of trackedFiles) await fetchFile(file)
    }

    void poll()
    const timer = window.setInterval(() => {
      // Push owns refresh while its channels are live; this interval only backs it up while they
      // are connecting, degraded, or unsupported.
      if (!pushActive) void poll()
    }, intervalMs)

    const updateConnection = (file: string, connected: boolean): void => {
      if (!active) return
      const wasActive = pushActive
      connections.set(file, connected)
      pushActive = trackedFiles.every((entry) => connections.get(entry) === true)
      if (pushActive && !wasActive) {
        // (Re)connected: re-pull everything to catch notifications missed while offline.
        void poll()
      }
    }

    for (const file of trackedFiles) {
      subscriptions.set(
        file,
        subscribeUniverFileEvents(
          file,
          () => {
            if (!active) return
            if (document.visibilityState === 'hidden') {
              // The push channel stays live while hidden; defer the pull until visible again.
              deferredWhileHidden.add(file)
              return
            }
            void fetchFile(file)
          },
          (connected) => updateConnection(file, connected)
        )
      )
    }

    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') return
      if (!pushActive) {
        void poll()
        return
      }
      const due = [...deferredWhileHidden]
      deferredWhileHidden.clear()
      for (const file of due) void fetchFile(file)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      active = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      for (const subscription of subscriptions.values()) subscription.dispose()
      subscriptions.clear()
    }
  }, [key, sessionId, intervalMs])
  return {
    states,
    missingFiles: React.useMemo(() => new Set(Object.keys(missing)), [missing]),
    applyState: React.useCallback((state: FileState) => {
      setStates((previous) => ({ ...previous, [state.file]: state }))
      setMissing((previous) => {
        if (previous[state.file] === undefined) return previous
        const next = { ...previous }
        delete next[state.file]
        return next
      })
    }, [])
  }
}

/** Gateway state and start action used by preview surfaces. */
export function useGatewayStatus(): {
  readonly phase: 'checking' | 'stopped' | 'starting' | 'running' | 'failed'
  readonly start: () => Promise<void>
} {
  const [phase, setPhase] = React.useState<
    'checking' | 'stopped' | 'starting' | 'running' | 'failed'
  >('checking')
  React.useEffect(() => {
    let active = true
    void getUniverStatus()
      .then((status) => {
        if (active) setPhase(status.gateway.phase)
      })
      .catch(() => {
        if (active) setPhase('failed')
      })
    return () => {
      active = false
    }
  }, [])
  const start = React.useCallback(async () => {
    setPhase('starting')
    try {
      const result = await startGateway()
      setPhase(result.ok ? 'running' : 'failed')
    } catch {
      setPhase('failed')
    }
  }, [])
  return { phase, start }
}
