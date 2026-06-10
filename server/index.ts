import express from 'express'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readFileSync, writeFileSync } from 'fs'

const require = createRequire(import.meta.url)
const dotenv = require('dotenv')
dotenv.config()

const app = express()
app.use(express.json())

const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI ?? 'http://localhost:3001/auth/callback'
const CREDS_FILE = join(dirname(fileURLToPath(import.meta.url)), '../spotify-credentials.json')

// ─── Credential store ─────────────────────────────────────────
// Env vars take priority; fall back to saved file from setup wizard
let clientId = process.env.SPOTIFY_CLIENT_ID ?? ''
let clientSecret = process.env.SPOTIFY_CLIENT_SECRET ?? ''

// ─── In-memory token store (single user) ─────────────────────
let accessToken: string | null = null
let refreshToken: string | null = null
let tokenExpiry = 0

try {
  const saved = JSON.parse(readFileSync(CREDS_FILE, 'utf8')) as Record<string, string>
  if (!clientId && saved.clientId) clientId = saved.clientId
  if (!clientSecret && saved.clientSecret) clientSecret = saved.clientSecret
  if (saved.refreshToken) refreshToken = saved.refreshToken
} catch { /* file doesn't exist yet — that's fine */ }

// Merge the current refresh token back into the credentials file.
// Reads first so clientId/clientSecret are never clobbered.
function saveTokens(): void {
  try {
    let file: Record<string, unknown> = {}
    try { file = JSON.parse(readFileSync(CREDS_FILE, 'utf8')) } catch { /* new file */ }
    if (refreshToken) file.refreshToken = refreshToken
    else delete file.refreshToken
    writeFileSync(CREDS_FILE, JSON.stringify(file, null, 2))
  } catch { /* non-fatal */ }
}

// On startup, try to exchange the saved refresh token for a fresh
// access token so the user doesn't have to re-authorize after a restart.
async function tryRestoreSession(): Promise<void> {
  if (!refreshToken || !clientId || !clientSecret) return
  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    })
    if (!response.ok) {
      refreshToken = null
      saveTokens()
      console.log('  Saved session expired — re-authorization required.')
      return
    }
    const data = (await response.json()) as Record<string, unknown>
    accessToken = data.access_token as string
    tokenExpiry = Date.now() + (data.expires_in as number) * 1000
    if (data.refresh_token) { refreshToken = data.refresh_token as string; saveTokens() }
    console.log('  Session restored from saved refresh token.')
  } catch {
    console.log('  Could not reach Spotify on startup — will try again on first request.')
  }
}

// ─── Setup routes ─────────────────────────────────────────────
app.get('/setup/status', (_req, res) => {
  res.json({
    hasCredentials: !!(clientId && clientSecret),
    authenticated: !!accessToken,
    redirectUri: REDIRECT_URI,
  })
})

app.post('/setup/credentials', async (req, res) => {
  const { clientId: id, clientSecret: secret } = req.body as Record<string, string>
  if (!id?.trim() || !secret?.trim()) {
    res.status(400).json({ error: 'Client ID and Client Secret are required.' })
    return
  }

  // Validate by doing a client_credentials token request (no user needed)
  const testRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${id.trim()}:${secret.trim()}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  })

  if (!testRes.ok) {
    res.status(400).json({ error: 'Invalid credentials — double-check your Client ID and Secret.' })
    return
  }

  clientId = id.trim()
  clientSecret = secret.trim()
  // Clear any existing session so user re-authorizes with new credentials
  accessToken = null
  refreshToken = null
  tokenExpiry = 0

  try {
    // Write only clientId/clientSecret — no leftover refreshToken from a previous account
    writeFileSync(CREDS_FILE, JSON.stringify({ clientId, clientSecret }, null, 2))
  } catch { /* non-fatal if write fails */ }

  res.json({ ok: true })
})

// ─── Auth routes ──────────────────────────────────────────────
app.get('/auth/login', (_req, res) => {
  if (!clientId || !clientSecret) {
    res.status(400).send('Credentials not configured — complete setup first.')
    return
  }

  const scopes = [
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'playlist-read-private',
    'playlist-read-collaborative',
  ].join(' ')

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: scopes,
  })

  res.redirect(`https://accounts.spotify.com/authorize?${params}`)
})

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code as string | undefined
  if (!code) { res.status(400).send('Missing code'); return }

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
    })

    const data = (await response.json()) as Record<string, unknown>
    accessToken  = data.access_token as string
    refreshToken = data.refresh_token as string
    tokenExpiry  = Date.now() + (data.expires_in as number) * 1000
    saveTokens()

    // Close the browser tab and signal the WebView to proceed
    res.send(
      '<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#121212;color:#fff">' +
        '<p style="font-size:48px">✓</p>' +
        '<h2 style="color:#1db954">Spotify connected!</h2>' +
        '<p style="color:#b3b3b3">You can close this tab and return to the app.</p>' +
        '<script>setTimeout(()=>window.close(),2500)</script>' +
        '</body></html>'
    )
  } catch {
    res.status(500).send('Authentication failed')
  }
})

app.get('/auth/status', (_req, res) => {
  res.json({ authenticated: !!accessToken })
})

// ─── Token management ─────────────────────────────────────────
async function ensureToken(): Promise<string> {
  if (!clientId || !clientSecret) throw new Error('Credentials not configured')
  if (!accessToken) throw new Error('Not authenticated')

  if (refreshToken && Date.now() > tokenExpiry - 60_000) {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    })
    const data = (await response.json()) as Record<string, unknown>
    accessToken = data.access_token as string
    tokenExpiry = Date.now() + (data.expires_in as number) * 1000
    // Spotify occasionally rotates the refresh token — save the new one if present
    if (data.refresh_token) { refreshToken = data.refresh_token as string; saveTokens() }
  }

  return accessToken
}

// Distinguish "not logged in" from real server errors so the
// frontend can route back to the setup wizard on 401
function errStatus(err: unknown): number {
  const msg = String(err)
  if (msg.includes('Not authenticated') || msg.includes('Credentials not configured')) return 401
  if (msg.includes('Spotify 401')) return 401
  return 500
}

// ─── Spotify API helper ───────────────────────────────────────
async function spotifyRequest(method: string, path: string, body?: object): Promise<unknown> {
  const token = await ensureToken()
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (res.status === 204) return null
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Spotify ${res.status}: ${text}`)
  }
  return res.json()
}

// ─── Player routes ────────────────────────────────────────────
app.get('/api/player', async (_req, res) => {
  try { res.json(await spotifyRequest('GET', '/me/player')) }
  catch (err) { res.status(errStatus(err)).json({ error: String(err) }) }
})

app.post('/api/player/play', async (req, res) => {
  try { await spotifyRequest('PUT', '/me/player/play', req.body ?? {}); res.json({ ok: true }) }
  catch (err) { res.status(errStatus(err)).json({ error: String(err) }) }
})

app.post('/api/player/pause', async (_req, res) => {
  try { await spotifyRequest('PUT', '/me/player/pause'); res.json({ ok: true }) }
  catch (err) { res.status(errStatus(err)).json({ error: String(err) }) }
})

app.post('/api/player/next', async (_req, res) => {
  try { await spotifyRequest('POST', '/me/player/next'); res.json({ ok: true }) }
  catch (err) { res.status(errStatus(err)).json({ error: String(err) }) }
})

app.post('/api/player/previous', async (_req, res) => {
  try { await spotifyRequest('POST', '/me/player/previous'); res.json({ ok: true }) }
  catch (err) { res.status(errStatus(err)).json({ error: String(err) }) }
})

app.post('/api/player/seek', async (req, res) => {
  const position = Number(req.query.position_ms)
  if (!Number.isFinite(position) || position < 0) {
    res.status(400).json({ error: 'position_ms must be a non-negative number' })
    return
  }
  try {
    await spotifyRequest('PUT', `/me/player/seek?position_ms=${Math.floor(position)}`)
    res.json({ ok: true })
  } catch (err) { res.status(errStatus(err)).json({ error: String(err) }) }
})

// ─── Playlist routes ──────────────────────────────────────────
app.get('/api/playlists', async (_req, res) => {
  try { res.json(await spotifyRequest('GET', '/me/playlists?limit=50')) }
  catch (err) { res.status(errStatus(err)).json({ error: String(err) }) }
})

app.get('/api/playlists/:id/tracks', async (req, res) => {
  try {
    const fields = 'items(track(id,name,uri,duration_ms,artists(name))),total'
    const MAX_TRACKS = 200
    type Page = { items: unknown[]; total: number }

    const first = (await spotifyRequest(
      'GET',
      `/playlists/${req.params.id}/tracks?limit=50&fields=${encodeURIComponent(fields)}`
    )) as Page

    const items = [...first.items]
    while (items.length < Math.min(first.total, MAX_TRACKS)) {
      const page = (await spotifyRequest(
        'GET',
        `/playlists/${req.params.id}/tracks?limit=50&offset=${items.length}&fields=${encodeURIComponent(fields)}`
      )) as Page
      if (!page.items.length) break
      items.push(...page.items)
    }

    res.json({ items, total: first.total })
  } catch (err) { res.status(errStatus(err)).json({ error: String(err) }) }
})

app.listen(3001, () => {
  console.log('Spotify G2 server → http://localhost:3001')
  if (!clientId) {
    console.log('  No credentials yet — open the app and follow setup.')
  } else {
    tryRestoreSession().then(() => {
      if (!accessToken) console.log('  Credentials loaded. Open /auth/login to authorize.')
    })
  }
})
