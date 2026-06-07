// Companion web UI — runs in the Even Hub WebView alongside the glasses bridge

// ── Types ──────────────────────────────────────────────────────
interface PlaybackState {
  is_playing: boolean
  progress_ms?: number
  item?: {
    name: string
    uri: string
    duration_ms: number
    artists: { name: string }[]
    album: {
      images: { url: string; width: number }[]
    }
  }
}

interface Playlist {
  id: string
  name: string
  tracks: { total: number }
  images: { url: string }[]
}

interface Track {
  id: string
  name: string
  uri: string
  duration_ms?: number
  artists: { name: string }[]
}

// ── State ──────────────────────────────────────────────────────
let playback: PlaybackState | null = null
let playlists: Playlist[] = []
let tracks: Track[] = []
let selectedPlaylist: Playlist | null = null
let localProgress = 0
let localDuration = 1
let progressTimer: ReturnType<typeof setInterval> | null = null
let currentAlbumUrl = ''

// ── API ────────────────────────────────────────────────────────
async function api<T>(path: string, method = 'GET', body?: object): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 204) return null as T
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

// ── Helpers ────────────────────────────────────────────────────
function ms(n: number): string {
  const s = Math.floor(n / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

function showView(id: 'view-auth' | 'view-main' | 'view-tracks') {
  document.querySelectorAll<HTMLElement>('.view').forEach((v) => v.classList.remove('active'))
  el(id).classList.add('active')
}

// ── Now Playing ────────────────────────────────────────────────
function updateProgressDisplay() {
  const pct = Math.min((localProgress / localDuration) * 100, 100)
  el('progress-fill').style.width = `${pct}%`
  el('progress-current').textContent = ms(localProgress)
  el('progress-total').textContent = ms(localDuration)
}

function startProgressTimer(playing: boolean) {
  if (progressTimer) clearInterval(progressTimer)
  if (!playing) return
  progressTimer = setInterval(() => {
    localProgress = Math.min(localProgress + 1000, localDuration)
    updateProgressDisplay()
  }, 1000)
}

function renderPlayback() {
  const hasTrack = !!playback?.item

  ;(el<HTMLButtonElement>('btn-play')).disabled = !hasTrack
  ;(el<HTMLButtonElement>('btn-prev')).disabled = !hasTrack
  ;(el<HTMLButtonElement>('btn-next')).disabled = !hasTrack

  if (!hasTrack) {
    el('track-name').textContent = 'Nothing playing'
    el('artist-name').textContent = 'Open Spotify on a device to start'
    el('progress-fill').style.width = '0%'
    el('progress-current').textContent = '0:00'
    el('progress-total').textContent = '0:00'
    el('icon-play').style.display = ''
    el('icon-pause').style.display = 'none'
    startProgressTimer(false)
    return
  }

  const { item, is_playing, progress_ms = 0 } = playback!

  el('track-name').textContent = item!.name
  el('artist-name').textContent = item!.artists.map((a) => a.name).join(', ')

  // Play / Pause icon
  el('icon-play').style.display = is_playing ? 'none' : ''
  el('icon-pause').style.display = is_playing ? '' : 'none'

  // Album art — only swap DOM if URL changed
  const imgUrl = item!.album.images[0]?.url ?? ''
  if (imgUrl !== currentAlbumUrl) {
    currentAlbumUrl = imgUrl
    const img = el<HTMLImageElement>('album-img')
    const placeholder = el('album-placeholder')
    if (imgUrl) {
      img.src = imgUrl
      img.onload = () => { img.classList.add('loaded'); placeholder.style.display = 'none' }
      img.onerror = () => { img.classList.remove('loaded'); placeholder.style.display = '' }
    } else {
      img.classList.remove('loaded')
      placeholder.style.display = ''
    }
  }

  // Progress
  localProgress = progress_ms
  localDuration = item!.duration_ms || 1
  // Disable CSS transition for large jumps (track change / seek)
  const fill = el('progress-fill')
  fill.style.transition = 'none'
  updateProgressDisplay()
  requestAnimationFrame(() => { fill.style.transition = '' })

  startProgressTimer(is_playing)
}

// ── Playlists ──────────────────────────────────────────────────
function renderPlaylists() {
  const list = el('playlist-list')
  list.innerHTML = ''

  if (playlists.length === 0) {
    list.innerHTML = '<div class="placeholder-msg">No playlists found.</div>'
    return
  }

  playlists.forEach((pl) => {
    const item = document.createElement('div')
    item.className = 'playlist-item'

    const thumbHtml = pl.images[0]?.url
      ? `<div class="pl-thumb"><img src="${pl.images[0].url}" alt="" loading="lazy" /></div>`
      : `<div class="pl-thumb">♪</div>`

    item.innerHTML = `
      ${thumbHtml}
      <div class="pl-info">
        <div class="pl-name">${pl.name}</div>
        <div class="pl-meta">${pl.tracks.total} songs</div>
      </div>
    `
    item.addEventListener('click', () => openPlaylist(pl))
    list.appendChild(item)
  })
}

// ── Tracks ─────────────────────────────────────────────────────
async function openPlaylist(pl: Playlist) {
  selectedPlaylist = pl
  el('tracks-title').textContent = pl.name
  el('track-list').innerHTML = '<div class="placeholder-msg">Loading…</div>'
  showView('view-tracks')

  try {
    const data = await api<{ items: { track: Track | null }[] }>(
      `/api/playlists/${pl.id}/tracks`
    )
    tracks = (data?.items ?? [])
      .filter((i) => i.track !== null)
      .map((i) => i.track as Track)
    renderTracks()
  } catch {
    el('track-list').innerHTML = '<div class="placeholder-msg">Failed to load tracks.</div>'
  }
}

function renderTracks() {
  const list = el('track-list')
  list.innerHTML = ''

  const currentUri = playback?.item?.uri

  tracks.forEach((track, i) => {
    const playing = track.uri === currentUri
    const item = document.createElement('div')
    item.className = `track-item${playing ? ' playing' : ''}`
    item.innerHTML = `
      <div class="track-num">${playing ? '♪' : i + 1}</div>
      <div class="track-item-info">
        <div class="track-item-name">${track.name}</div>
        <div class="track-item-artist">${track.artists.map((a) => a.name).join(', ')}</div>
      </div>
      ${track.duration_ms ? `<div class="track-dur">${ms(track.duration_ms)}</div>` : ''}
    `
    item.addEventListener('click', () => playTrack(track))
    list.appendChild(item)
  })
}

async function playTrack(track: Track) {
  if (!selectedPlaylist) return
  try {
    await api('/api/player/play', 'POST', {
      context_uri: `spotify:playlist:${selectedPlaylist.id}`,
      offset: { uri: track.uri },
    })
  } catch { /* fall through — navigate back regardless */ }
  showView('view-main')
  setTimeout(pollPlayback, 700)
}

// ── Polling ────────────────────────────────────────────────────
async function pollPlayback() {
  try {
    playback = await api<PlaybackState>('/api/player')
    renderPlayback()
  } catch { /* keep last state */ }
}

// ── Controls ───────────────────────────────────────────────────
function initControls() {
  el('btn-play').addEventListener('click', async () => {
    try {
      if (playback?.is_playing) {
        await api('/api/player/pause', 'POST')
      } else {
        await api('/api/player/play', 'POST')
      }
      setTimeout(pollPlayback, 400)
    } catch { /* ignore */ }
  })

  el('btn-prev').addEventListener('click', async () => {
    try { await api('/api/player/previous', 'POST') } catch { /* ignore */ }
    setTimeout(pollPlayback, 600)
  })

  el('btn-next').addEventListener('click', async () => {
    try { await api('/api/player/next', 'POST') } catch { /* ignore */ }
    setTimeout(pollPlayback, 600)
  })

  el('btn-back').addEventListener('click', () => showView('view-main'))
}

// ── Init ────────────────────────────────────────────────────────
async function init() {
  try {
    const status = await api<{ authenticated: boolean }>('/auth/status')
    if (!status?.authenticated) { showView('view-auth'); return }
  } catch {
    showView('view-auth')
    return
  }

  showView('view-main')
  initControls()

  // Fetch playback + playlists in parallel
  await Promise.all([
    pollPlayback(),
    api<{ items: Playlist[] }>('/api/playlists')
      .then((data) => { playlists = data?.items ?? []; renderPlaylists() })
      .catch(() => {
        el('playlist-list').innerHTML = '<div class="placeholder-msg">Could not load playlists.</div>'
      }),
  ])

  // Keep playback state fresh
  setInterval(pollPlayback, 5_000)
}

init()
