// Companion web UI — runs in the Even Hub WebView alongside the glasses bridge

// ── Types ──────────────────────────────────────────────────────
interface SetupStatus {
  hasCredentials: boolean
  authenticated: boolean
  redirectUri: string
}

interface PlaybackState {
  is_playing: boolean
  progress_ms?: number
  item?: {
    name: string
    uri: string
    duration_ms: number
    artists: { name: string }[]
    album: { images: { url: string; width: number }[] }
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
  const data = text ? JSON.parse(text) : null
  // Setup endpoints return errors in the body; all other non-OK responses throw
  if (!res.ok && !path.startsWith('/setup')) {
    // Carry the server's error string so toastFromError can give a useful message
    const msg = (data as Record<string, string>)?.error ?? `HTTP ${res.status}`
    throw Object.assign(new Error(msg), { status: res.status })
  }
  return data
}

// ── Helpers ────────────────────────────────────────────────────
function ms(n: number): string {
  const s = Math.floor(n / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// Names from Spotify are user-controlled — escape before innerHTML
function esc(str: string): string {
  return str.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  )
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

// ── Toast ──────────────────────────────────────────────────────
let toastTimer: ReturnType<typeof setTimeout> | null = null

function showToast(message: string, type: 'error' | 'info' = 'error') {
  const toast = el('toast')
  if (toastTimer) clearTimeout(toastTimer)
  toast.textContent = message
  toast.className = `toast ${type}`
  // Force reflow so the transition fires even when re-showing
  void toast.offsetHeight
  toast.classList.add('show')
  toastTimer = setTimeout(() => toast.classList.remove('show'), 4_000)
}

function toastFromError(err: unknown) {
  const msg = String((err as Error)?.message ?? err)
  if (msg.includes('No active device') || msg.includes('404'))
    showToast('No active Spotify device — open Spotify on a device first.')
  else if (msg.includes('403') || msg.toLowerCase().includes('premium'))
    showToast('Spotify Premium is required for playback control.')
  else if (!msg.includes('401'))  // 401 is handled by redirect, not toast
    showToast('Command failed — try again.')
}

type ViewId = 'view-step1' | 'view-step2' | 'view-step3' | 'view-main' | 'view-tracks'
function showView(id: ViewId) {
  document.querySelectorAll<HTMLElement>('.view').forEach((v) => v.classList.remove('active'))
  el(id).classList.add('active')
}

// ── Wizard — Step 1 ───────────────────────────────────────────
function initStep1(redirectUri: string) {
  // Fill in the actual redirect URI from server config
  el('redirect-uri-display').textContent = redirectUri

  el('btn-copy-uri').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(redirectUri)
      const btn = el('btn-copy-uri')
      btn.textContent = 'Copied!'
      btn.classList.add('copied')
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied') }, 2000)
    } catch { /* clipboard not available in all WebViews */ }
  })

  el('btn-step1-next').addEventListener('click', () => showView('view-step2'))
}

// ── Wizard — Step 2 ───────────────────────────────────────────
function initStep2() {
  const btnSave  = el<HTMLButtonElement>('btn-save-creds')
  const errBox   = el('creds-error')
  const idInput  = el<HTMLInputElement>('input-client-id')
  const secInput = el<HTMLInputElement>('input-client-secret')

  btnSave.addEventListener('click', async () => {
    const clientId     = idInput.value.trim()
    const clientSecret = secInput.value.trim()

    errBox.classList.remove('visible')
    idInput.classList.remove('error')
    secInput.classList.remove('error')

    if (!clientId)     { idInput.classList.add('error');  return }
    if (!clientSecret) { secInput.classList.add('error'); return }

    btnSave.disabled = true
    el('btn-save-label').textContent = 'Verifying…'

    try {
      const result = await api<{ ok?: boolean; error?: string }>(
        '/setup/credentials',
        'POST',
        { clientId, clientSecret }
      )

      if (result?.ok) {
        showView('view-step3')
      } else {
        showError(result?.error ?? 'Something went wrong.')
      }
    } catch {
      showError('Could not reach the server. Is it running?')
    } finally {
      btnSave.disabled = false
      el('btn-save-label').textContent = 'Continue'
    }
  })

  function showError(msg: string) {
    errBox.textContent = msg
    errBox.classList.add('visible')
  }
}

// ── Wizard — Step 3 ───────────────────────────────────────────
function initStep3() {
  el('btn-check-auth').addEventListener('click', async () => {
    try {
      const status = await api<{ authenticated: boolean }>('/auth/status')
      if (status?.authenticated) {
        await launchMain()
      } else {
        // Flash the button to prompt them to authorize first
        const btn = el('btn-check-auth')
        btn.textContent = 'Not authorized yet — tap "Authorize with Spotify" first'
        setTimeout(() => { btn.textContent = 'I\'ve authorized — continue' }, 3000)
      }
    } catch {
      /* ignore */
    }
  })
}

// ── Main view ─────────────────────────────────────────────────
async function launchMain() {
  showView('view-main')
  initControls()
  await Promise.all([
    pollPlayback(),
    api<{ items: Playlist[] }>('/api/playlists')
      .then((data) => { playlists = data?.items ?? []; renderPlaylists() })
      .catch((err) => {
        el('playlist-list').innerHTML = '<div class="placeholder-msg">Could not load playlists.</div>'
        toastFromError(err)
      }),
  ])
  setInterval(pollPlayback, 5_000)
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
    // Track ended — fetch what's playing now instead of freezing at 100%
    if (localProgress >= localDuration) {
      if (progressTimer) clearInterval(progressTimer)
      setTimeout(pollPlayback, 1200)
    }
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
  el('icon-play').style.display  = is_playing ? 'none' : ''
  el('icon-pause').style.display = is_playing ? '' : 'none'

  const imgUrl = item!.album.images[0]?.url ?? ''
  if (imgUrl !== currentAlbumUrl) {
    currentAlbumUrl = imgUrl
    const img = el<HTMLImageElement>('album-img')
    const placeholder = el('album-placeholder')
    if (imgUrl) {
      img.src = imgUrl
      img.onload  = () => { img.classList.add('loaded'); placeholder.style.display = 'none' }
      img.onerror = () => { img.classList.remove('loaded'); placeholder.style.display = '' }
    } else {
      img.classList.remove('loaded')
      placeholder.style.display = ''
    }
  }

  localProgress = progress_ms
  localDuration = item!.duration_ms || 1
  // Skip CSS transition when jumping (track change / first load)
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
      ? `<div class="pl-thumb"><img src="${esc(pl.images[0].url)}" alt="" loading="lazy" /></div>`
      : `<div class="pl-thumb">♪</div>`
    item.innerHTML = `
      ${thumbHtml}
      <div class="pl-info">
        <div class="pl-name">${esc(pl.name)}</div>
        <div class="pl-meta">${pl.tracks.total} songs</div>
      </div>`
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
    tracks = (data?.items ?? []).filter((i) => i.track !== null).map((i) => i.track as Track)
    renderTracks()
  } catch (err) {
    el('track-list').innerHTML = '<div class="placeholder-msg">Failed to load tracks.</div>'
    toastFromError(err)
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
        <div class="track-item-name">${esc(track.name)}</div>
        <div class="track-item-artist">${esc(track.artists.map((a) => a.name).join(', '))}</div>
      </div>
      ${track.duration_ms ? `<div class="track-dur">${ms(track.duration_ms)}</div>` : ''}`
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
  } catch (err) {
    toastFromError(err)
  }
  showView('view-main')
  setTimeout(pollPlayback, 700)
}

// ── Polling ────────────────────────────────────────────────────
async function pollPlayback() {
  try {
    playback = await api<PlaybackState>('/api/player')
    renderPlayback()
  } catch (err) {
    // Server restarted and lost the session — send user to re-authorize
    if ((err as { status?: number }).status === 401) {
      showView('view-step3')
    }
    /* otherwise keep last state */
  }
}

// ── Controls ───────────────────────────────────────────────────
function initControls() {
  el('btn-play').addEventListener('click', async () => {
    try {
      if (playback?.is_playing) await api('/api/player/pause', 'POST')
      else                      await api('/api/player/play',  'POST')
      setTimeout(pollPlayback, 400)
    } catch (err) { toastFromError(err) }
  })
  el('btn-prev').addEventListener('click', async () => {
    try { await api('/api/player/previous', 'POST') }
    catch (err) { toastFromError(err) }
    setTimeout(pollPlayback, 600)
  })
  el('btn-next').addEventListener('click', async () => {
    try { await api('/api/player/next', 'POST') }
    catch (err) { toastFromError(err) }
    setTimeout(pollPlayback, 600)
  })
  el('btn-back').addEventListener('click', () => showView('view-main'))

  // Click/tap progress bar to seek
  document.querySelector<HTMLElement>('.progress-bar')?.addEventListener('click', async (e) => {
    if (!playback?.item) return
    const bar = e.currentTarget as HTMLElement
    const rect = bar.getBoundingClientRect()
    const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1)
    const positionMs = Math.floor(ratio * localDuration)
    localProgress = positionMs
    updateProgressDisplay()
    try { await api(`/api/player/seek?position_ms=${positionMs}`, 'POST') } catch { /* ignore */ }
    setTimeout(pollPlayback, 600)
  })
}

// ── Init ────────────────────────────────────────────────────────
async function init() {
  try {
    const status = await api<SetupStatus>('/setup/status')

    // Populate redirect URI in step 1 from server config
    initStep1(status?.redirectUri ?? 'http://localhost:3001/auth/callback')
    initStep2()
    initStep3()

    if (status?.authenticated) {
      await launchMain()
    } else if (status?.hasCredentials) {
      // Have credentials but not yet authorized
      showView('view-step3')
    } else {
      // Fresh install — start at step 1
      showView('view-step1')
    }
  } catch {
    // Server not reachable — show step 1 and let user proceed
    initStep1('http://localhost:3001/auth/callback')
    initStep2()
    initStep3()
    showView('view-step1')
  }
}

init()
