import { VIEWER_WS_TUNNEL } from '../../shared/wire/viewer.ts'

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 30_000

/** The univerfile channel tail: worktree registry/status events plus trunk `unit_*`. */
const FILE_EVENTS_TAIL = '/events'

export interface UniverFileEventsHandle {
  /**
   * Follow the given live worktrees so their channels carry that worktree's `unit_*` events,
   * which the univerfile channel does not relay. Closing dropped worktrees keeps connections
   * bounded to the worktrees the projection still shows.
   */
  setWorktrees(worktreeIds: readonly string[]): void
  /** Close every channel and stop reconnecting. */
  dispose(): void
}

/**
 * Push subscriptions for one `.univer` file, reusing the Gateway lifecycle-event channels through
 * the same-origin `/univer-viewer/ws` tunnel (`?target=` carries the dynamic upstream path because
 * DSH upgrade registration supports exact paths only). The tunnel relies on DSH connection
 * authentication and never sets or reads a plugin session cookie, matching the Viewer contract;
 * this module deliberately treats every frame as an opaque invalidation notice — callers re-pull
 * authoritative state over the session-scoped HTTP API, so no state crosses sessions here.
 * Each channel reconnects with exponential backoff and jitter until `dispose()`; the sockets stay
 * open while the page is hidden (the advantage over polling), and connection flips are reported so
 * the owner can toggle its polling fallback.
 */
export function subscribeUniverFileEvents(
  file: string,
  onEvent: () => void,
  onConnectionChange: (connected: boolean) => void
): UniverFileEventsHandle {
  const prefix = `/uf/${encodeUniverFileKey(file)}`
  const channels = new Map<string, { close(): void; isOpen(): boolean }>()
  let reportedConnected = false

  // Push counts as live only when every channel of the file is open; one degraded channel makes
  // the owner fall back to polling, which covers all files instead of a subset.
  const reportState = (): void => {
    let connected = channels.size > 0
    for (const channel of channels.values()) {
      if (!channel.isOpen()) {
        connected = false
        break
      }
    }
    if (connected !== reportedConnected) {
      reportedConnected = connected
      onConnectionChange(connected)
    }
  }

  const openChannel = (target: string): void => {
    channels.set(
      target,
      openTunneledEventChannel(target, { onEvent, onOpenStateChange: reportState })
    )
  }

  openChannel(`${prefix}${FILE_EVENTS_TAIL}`)

  return {
    setWorktrees(worktreeIds: readonly string[]): void {
      const wanted = new Set(
        worktreeIds.map((worktreeId) => `${prefix}/worktrees/${worktreeId}${FILE_EVENTS_TAIL}`)
      )
      for (const [target, channel] of channels) {
        if (target !== `${prefix}${FILE_EVENTS_TAIL}` && !wanted.has(target)) {
          channel.close()
          channels.delete(target)
        }
      }
      for (const target of wanted) {
        if (!channels.has(target)) openChannel(target)
      }
      reportState()
    },
    dispose: () => {
      for (const channel of channels.values()) channel.close()
      channels.clear()
    }
  }
}

function openTunneledEventChannel(
  target: string,
  handlers: {
    readonly onEvent: () => void
    readonly onOpenStateChange: () => void
  }
): { close(): void; isOpen(): boolean } {
  let ws: WebSocket | undefined
  let closed = false
  let open = false
  let attempt = 0
  let retryTimer: number | undefined

  const connect = (): void => {
    if (closed) return
    const url = new URL(VIEWER_WS_TUNNEL, window.location.origin)
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('target', target)
    ws = new WebSocket(url)
    ws.onopen = () => {
      open = true
      attempt = 0
      handlers.onOpenStateChange()
    }
    ws.onmessage = (message: MessageEvent) => {
      // Lifecycle frames are text JSON; their payload is irrelevant because the caller refreshes
      // through the authoritative HTTP API anyway.
      if (typeof message.data === 'string') handlers.onEvent()
    }
    // Errors always surface as a close; schedule the retry from onclose only.
    ws.onclose = () => {
      const wasOpen = open
      open = false
      ws = undefined
      if (wasOpen) handlers.onOpenStateChange()
      if (closed) return
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS)
      attempt += 1
      retryTimer = window.setTimeout(connect, delay * (0.5 + Math.random() * 0.5))
    }
  }

  connect()

  return {
    close: () => {
      closed = true
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      ws?.close()
    },
    isOpen: () => open
  }
}

/** The Gateway addresses files as `base64url(absolute .univer path)` without padding. */
function encodeUniverFileKey(path: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(path)) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
