import express from 'express'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const require = createRequire(import.meta.url)
const dotenv = require('dotenv')
dotenv.config()

const app = express()
app.use(express.json())

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID!
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET!
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI ?? 'http://localhost:3001/auth/callback'

// ─── In-memory token store (single user) ─────────────────────
let accessToken: string | null = null
let refreshToken: string | null = null
let tokenExpiry = 0

// ─── Auth routes ──────────────────────────────────────────────
app.get('/auth/login', (_req, res) => {
  const scopes = [
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'playlist-read-private',
    'playlist-read-collaborative',
  ].join(' ')

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: scopes,
  })

  res.redirect(`https://accounts.spotify.com/authorize?${params}`)
})

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code as string | undefined
  if (!code) {
    res.status(400).send('Missing code')
    return
  }

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
    })

    const data = (await response.json()) as Record<string, unknown>
    accessToken = data.access_token as string
    refreshToken = data.refresh_token as string
    tokenExpiry = Date.now() + (data.expires_in as number) * 1000

    res.send(
      '<html><body style="font-family:sans-serif;text-align:center;padding:40px">' +
        '<h2>✓ Spotify connected!</h2>' +
        '<p>You can close this tab. Tap the glasses to refresh.</p>' +
        '<script>setTimeout(()=>window.close(),2000)</script>' +
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
  if (!accessToken) throw new Error('Not authenticated')

  if (refreshToken && Date.now() > tokenExpiry - 60_000) {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    })
    const data = (await response.json()) as Record<string, unknown>
    accessToken = data.access_token as string
    tokenExpiry = Date.now() + (data.expires_in as number) * 1000
  }

  return accessToken
}

// ─── Spotify API helpers ──────────────────────────────────────
async function spotifyRequest(
  method: string,
  path: string,
  body?: object
): Promise<unknown> {
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
  try {
    const data = await spotifyRequest('GET', '/me/player')
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.post('/api/player/play', async (req, res) => {
  try {
    await spotifyRequest('PUT', '/me/player/play', req.body ?? {})
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.post('/api/player/pause', async (_req, res) => {
  try {
    await spotifyRequest('PUT', '/me/player/pause')
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.post('/api/player/next', async (_req, res) => {
  try {
    await spotifyRequest('POST', '/me/player/next')
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.post('/api/player/previous', async (_req, res) => {
  try {
    await spotifyRequest('POST', '/me/player/previous')
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// ─── Playlist routes ──────────────────────────────────────────
app.get('/api/playlists', async (_req, res) => {
  try {
    const data = await spotifyRequest('GET', '/me/playlists?limit=50')
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.get('/api/playlists/:id/tracks', async (req, res) => {
  try {
    const fields = 'items(track(id,name,uri,artists(name))),total'
    const data = await spotifyRequest(
      'GET',
      `/playlists/${req.params.id}/tracks?limit=50&fields=${encodeURIComponent(fields)}`
    )
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.listen(3001, () => {
  console.log('Spotify G2 backend running on http://localhost:3001')
  console.log('To authenticate: open http://localhost:3001/auth/login in your browser')
})
