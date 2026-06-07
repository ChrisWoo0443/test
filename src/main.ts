import {
  waitForEvenAppBridge,
  EvenAppBridge,
  CreateStartUpPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import type { EvenHubEvent } from '@evenrealities/even_hub_sdk'

// ─── Types ────────────────────────────────────────────────────
// NOW_PLAYING and PLAYLISTS are the two top-level tabs.
// TRACKS is a drill-down from PLAYLISTS.
type Screen = 'AUTH' | 'NOW_PLAYING' | 'PLAYLISTS' | 'TRACKS'

interface SpotifyPlaylist {
  id: string
  name: string
  tracks: { total: number }
}

interface SpotifyTrack {
  id: string
  name: string
  uri: string
  artists: { name: string }[]
}

interface PlaybackState {
  is_playing: boolean
  item?: {
    name: string
    artists: { name: string }[]
  }
}

// ─── App state ────────────────────────────────────────────────
let bridge: EvenAppBridge
let currentScreen: Screen = 'NOW_PLAYING'

let playlists: SpotifyPlaylist[] = []
let tracks: SpotifyTrack[] = []
let selectedPlaylist: SpotifyPlaylist | null = null
let playlistIndex = 0
let trackIndex = 0
let playback: PlaybackState | null = null

let scrollCooldown = false
let isLoading = false

const CONTAINER_ID = 1
const CONTAINER_NAME = 'spotify'
const MAX_LIST_ROWS = 6  // one row reserved for tab bar

// ─── API helper ───────────────────────────────────────────────
async function api<T = unknown>(
  path: string,
  method = 'GET',
  body?: object
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 204) return null as T
  if (!res.ok) throw new Error(`API ${res.status}`)
  const text = await res.text()
  return text ? (JSON.parse(text) as T) : (null as T)
}

// ─── Display builders ─────────────────────────────────────────
function trunc(str: string, len: number): string {
  return str.length > len ? str.slice(0, len - 1) + '…' : str
}

// Tab bar shown at the top of every main screen
function tabBar(): string {
  const nowActive  = currentScreen === 'NOW_PLAYING'
  const listActive = currentScreen === 'PLAYLISTS' || currentScreen === 'TRACKS'
  const nowLabel  = nowActive  ? '[♪ Now Playing]' : '  Now Playing '
  const listLabel = listActive ? '[≡ Playlists]  ' : '  Playlists   '
  return `${nowLabel}  ${listLabel}`
}

function buildScrollList(items: string[], selectedIdx: number, hint: string): string {
  const start = Math.max(0, Math.min(selectedIdx, items.length - MAX_LIST_ROWS))
  const visible = items.slice(start, start + MAX_LIST_ROWS)
  const lines: string[] = []

  visible.forEach((item, i) => {
    const marker = start + i === selectedIdx ? '▶ ' : '  '
    lines.push(marker + trunc(item, 25))
  })

  if (items.length > MAX_LIST_ROWS) {
    lines.push(`  ${start + 1}–${Math.min(start + MAX_LIST_ROWS, items.length)} of ${items.length}`)
  }

  lines.push(hint)
  return lines.join('\n')
}

function screenContent(): string {
  switch (currentScreen) {
    case 'AUTH':
      return [
        '♪ Spotify G2',
        '─'.repeat(22),
        'Not connected to Spotify.',
        '',
        'Open in your browser:',
        'localhost:3001/auth/login',
        '',
        'Then tap to refresh.',
      ].join('\n')

    case 'NOW_PLAYING': {
      const header = [tabBar(), '─'.repeat(30)]

      if (isLoading) return [...header, '', 'Connecting…'].join('\n')

      if (!playback?.item) {
        return [
          ...header,
          'Nothing playing.',
          '',
          'Start Spotify on a device,',
          'then tap to refresh.',
          '',
          'D-Tap → switch to Playlists',
        ].join('\n')
      }

      const { item, is_playing } = playback
      return [
        ...header,
        trunc(item.name, 28),
        trunc(item.artists.map((a) => a.name).join(', '), 28),
        '',
        is_playing ? '▶ Playing' : '⏸ Paused',
        '',
        'Tap=Play/Pause  ↑Prev  ↓Next',
        'D-Tap → Playlists tab',
      ].join('\n')
    }

    case 'PLAYLISTS': {
      const header = [tabBar(), '─'.repeat(30)]
      if (playlists.length === 0) return [...header, '', 'Loading…'].join('\n')
      return [
        ...header,
        buildScrollList(
          playlists.map((p) => p.name),
          playlistIndex,
          'Tap=Open  D-Tap→Now Playing  ↑↓'
        ),
      ].join('\n')
    }

    case 'TRACKS': {
      const title = selectedPlaylist ? trunc(selectedPlaylist.name, 22) : 'Tracks'
      const header = [`← ${title}`, '─'.repeat(30)]
      if (tracks.length === 0) return [...header, '', 'Loading…'].join('\n')
      return [
        ...header,
        buildScrollList(
          tracks.map((t) => t.name),
          trackIndex,
          'Tap=Play  D-Tap=Back  ↑↓ Move'
        ),
      ].join('\n')
    }
  }
}

// ─── Display update ───────────────────────────────────────────
async function render(): Promise<void> {
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: CONTAINER_ID,
      containerName: CONTAINER_NAME,
      content: screenContent(),
    })
  )
}

// ─── Spotify actions ──────────────────────────────────────────
async function refreshPlayback(): Promise<void> {
  try {
    const data = await api<PlaybackState>('/api/player')
    playback = data
  } catch {
    playback = null
  }
  if (currentScreen === 'NOW_PLAYING') await render()
}

async function loadPlaylists(): Promise<void> {
  try {
    const data = await api<{ items: SpotifyPlaylist[] }>('/api/playlists')
    playlists = data?.items ?? []
  } catch {
    playlists = []
  }
  if (currentScreen === 'PLAYLISTS') await render()
}

async function loadTracks(playlistId: string): Promise<void> {
  try {
    const data = await api<{ items: { track: SpotifyTrack | null }[] }>(
      `/api/playlists/${playlistId}/tracks`
    )
    tracks = (data?.items ?? [])
      .filter((i) => i.track !== null)
      .map((i) => i.track as SpotifyTrack)
  } catch {
    tracks = []
  }
  if (currentScreen === 'TRACKS') await render()
}

// ─── Event handlers ───────────────────────────────────────────

// TAP: auth-refresh | play-pause | open-playlist | play-track
async function handleTap(): Promise<void> {
  switch (currentScreen) {
    case 'AUTH': {
      const status = await api<{ authenticated: boolean }>('/auth/status')
      if (status?.authenticated) {
        currentScreen = 'NOW_PLAYING'
        isLoading = true
        await render()
        await refreshPlayback()
        isLoading = false
      }
      await render()
      break
    }

    case 'NOW_PLAYING':
      try {
        if (playback?.is_playing) {
          await api('/api/player/pause', 'POST')
        } else {
          await api('/api/player/play', 'POST')
        }
        setTimeout(refreshPlayback, 400)
      } catch { /* no active device */ }
      break

    case 'PLAYLISTS':
      if (playlists.length === 0) break
      selectedPlaylist = playlists[playlistIndex]
      tracks = []
      trackIndex = 0
      currentScreen = 'TRACKS'
      await render()
      loadTracks(selectedPlaylist.id)
      break

    case 'TRACKS':
      if (tracks.length === 0 || !selectedPlaylist) break
      try {
        await api('/api/player/play', 'POST', {
          context_uri: `spotify:playlist:${selectedPlaylist.id}`,
          offset: { uri: tracks[trackIndex].uri },
        })
      } catch { /* no active device — still navigate */ }
      currentScreen = 'NOW_PLAYING'
      await render()
      setTimeout(refreshPlayback, 600)
      break
  }
}

// D-TAP: switch tabs (top level) | go back (TRACKS)
async function handleDoubleTap(): Promise<void> {
  switch (currentScreen) {
    case 'NOW_PLAYING':
      currentScreen = 'PLAYLISTS'
      if (playlists.length === 0) loadPlaylists()
      await render()
      break

    case 'PLAYLISTS':
      currentScreen = 'NOW_PLAYING'
      await render()
      break

    case 'TRACKS':
      currentScreen = 'PLAYLISTS'
      await render()
      break
  }
}

// SCROLL UP: prev track | scroll list up
async function handleScrollUp(): Promise<void> {
  switch (currentScreen) {
    case 'NOW_PLAYING':
      try {
        await api('/api/player/previous', 'POST')
        setTimeout(refreshPlayback, 600)
      } catch { /* ignore */ }
      break

    case 'PLAYLISTS':
      playlistIndex = Math.max(0, playlistIndex - 1)
      await render()
      break

    case 'TRACKS':
      trackIndex = Math.max(0, trackIndex - 1)
      await render()
      break
  }
}

// SCROLL DOWN: next track | scroll list down
async function handleScrollDown(): Promise<void> {
  switch (currentScreen) {
    case 'NOW_PLAYING':
      try {
        await api('/api/player/next', 'POST')
        setTimeout(refreshPlayback, 600)
      } catch { /* ignore */ }
      break

    case 'PLAYLISTS':
      playlistIndex = Math.min(playlists.length - 1, playlistIndex + 1)
      await render()
      break

    case 'TRACKS':
      trackIndex = Math.min(tracks.length - 1, trackIndex + 1)
      await render()
      break
  }
}

// ─── Event routing ────────────────────────────────────────────
function resolveEvent(event: EvenHubEvent): number | undefined {
  if (event.textEvent) return event.textEvent.eventType
  if (event.sysEvent) return event.sysEvent.eventType
  if (event.listEvent) return event.listEvent.eventType
  return undefined
}

function withScrollThrottle(fn: () => void): void {
  if (scrollCooldown) return
  scrollCooldown = true
  setTimeout(() => { scrollCooldown = false }, 300)
  fn()
}

async function onEvent(event: EvenHubEvent): Promise<void> {
  const type = resolveEvent(event)

  switch (type) {
    case OsEventTypeList.CLICK_EVENT:
    case undefined:
      await handleTap()
      break

    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      await handleDoubleTap()
      break

    case OsEventTypeList.SCROLL_TOP_EVENT:
      withScrollThrottle(() => { handleScrollUp() })
      break

    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      withScrollThrottle(() => { handleScrollDown() })
      break
  }
}

// ─── Bootstrap ────────────────────────────────────────────────
async function main(): Promise<void> {
  bridge = await waitForEvenAppBridge()

  bridge.onEvenHubEvent((event: EvenHubEvent) => {
    onEvent(event)
  })

  try {
    const status = await api<{ authenticated: boolean }>('/auth/status')
    if (!status?.authenticated) currentScreen = 'AUTH'
  } catch {
    currentScreen = 'AUTH'
  }

  // createStartUpPageContainer must be called exactly once
  await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: 1,
      textObject: [
        new TextContainerProperty({
          containerID: CONTAINER_ID,
          containerName: CONTAINER_NAME,
          content: screenContent(),
          xPosition: 20,
          yPosition: 20,
          width: 536,
          height: 248,
          borderWidth: 2,
          borderColor: 10,
          borderRdaius: '5',   // SDK typo — must match exactly
          paddingLength: 12,
          isEventCapture: 1,
        }),
      ],
    })
  )

  if (currentScreen === 'NOW_PLAYING') {
    await refreshPlayback()
  }

  // Keep Now Playing current while active
  setInterval(() => {
    if (currentScreen === 'NOW_PLAYING') refreshPlayback()
  }, 5_000)
}

main()
