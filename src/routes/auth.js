import { Router } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { getLoginUrl, exchangeCodeForToken, extendAccessToken, getPages } from '../services/facebook.js';

const router = Router();

// Simple in-memory state store (single-user personal app — fine).
const states = new Map();

router.get('/login', (req, res) => {
  if (!config.isConfigured()) {
    return res.status(500).json({ error: 'Facebook App not configured. Set FB_APP_ID and FB_APP_SECRET in .env then restart.' });
  }
  const state = crypto.randomBytes(16).toString('hex');
  states.set(state, Date.now());
  // prune old
  for (const [k, v] of states) if (Date.now() - v > 10 * 60 * 1000) states.delete(k);
  res.redirect(getLoginUrl(state));
});

router.get('/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) return res.status(400).send(`Facebook Login error: ${error} — ${error_description}`);
  if (!state || !states.has(String(state))) return res.status(400).send('Invalid state — please try logging in again.');
  states.delete(String(state));
  if (!code) return res.status(400).send('Missing code');

  try {
    const tokenData = await exchangeCodeForToken(String(code));
    let userToken = tokenData.access_token;
    let expiresAt = tokenData.expires_in ? Math.floor(Date.now() / 1000) + tokenData.expires_in : null;

    // Exchange for long-lived token (~60 days)
    try {
      const long = await extendAccessToken(userToken);
      userToken = long.access_token;
      expiresAt = Math.floor(Date.now() / 1000) + (long.expires_in || 5184000);
    } catch (e) {
      console.warn('[auth] extend token failed, keeping short-lived:', e.message);
    }

    const db = getDb();
    db.prepare(`INSERT OR REPLACE INTO user_tokens (id, access_token, expires_at, updated_at) VALUES (1, ?, ?, ?)`)
      .run(userToken, expiresAt, Math.floor(Date.now() / 1000));

    // Fetch pages and store their long-lived Page tokens
    const pages = await getPages(userToken);
    for (const p of pages) {
      db.prepare(`
        INSERT INTO pages (id, name, access_token, token_expires_at, category, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, access_token=excluded.access_token, category=excluded.category, updated_at=excluded.updated_at
      `).run(p.id, p.name, p.access_token, null, p.category || '', Math.floor(Date.now() / 1000));
    }

    // Remove demo pages if real pages were added
    if (pages.length) {
      db.prepare(`DELETE FROM pages WHERE access_token = 'DEMO_TOKEN_NOT_REAL'`).run();
      // Remove demo insights/posts? keep for history but not needed
      // Clear demo posts if real data exists
      const realCount = db.prepare(`SELECT COUNT(*) as c FROM posts WHERE page_id IN (SELECT id FROM pages WHERE access_token != 'DEMO_TOKEN_NOT_REAL')`).get().c;
      if (realCount === 0) {
        // keep demo posts until first real sync replaces them
      }
    }

    // Set a simple auth cookie (personal use — not multi-user)
    res.cookie('turnip_auth', '1', { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
    res.redirect('/?auth=success&pages=' + pages.length);
  } catch (e) {
    console.error('[auth] callback failed', e);
    const msg = e.isAuthError ? 'Authentication failed — check App ID/Secret and redirect URI match Meta console.' : e.message;
    res.status(500).send(`<h1>Login failed</h1><p>${escapeHtml(msg)}</p><p><a href="/">Back</a> — <a href="/api/auth/login">Try again</a></p>`);
  }
});

router.get('/status', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT expires_at, updated_at FROM user_tokens WHERE id = 1').get();
  const pages = db.prepare('SELECT id, name, category, updated_at, token_expires_at FROM pages').all();
  const syncStates = db.prepare('SELECT * FROM sync_state').all();
  const nowSec = Math.floor(Date.now() / 1000);
  let tokenStatus = 'not_connected';
  let expiresInDays = null;
  let needsReauth = false;
  if (user?.expires_at) {
    expiresInDays = (user.expires_at - nowSec) / 86400;
    if (expiresInDays <= 0) { tokenStatus = 'expired'; needsReauth = true; }
    else if (expiresInDays < 7) { tokenStatus = 'expiring_soon'; }
    else tokenStatus = 'valid';
  } else if (user) {
    tokenStatus = 'valid';
  }

  // Mark demo mode
  const isDemo = pages.every(p => p.id.startsWith('111') || p.id.startsWith('222')) || pages.length === 0;

  // Surface auth errors from sync
  const authErrors = syncStates.filter(s => s.last_error && s.last_error.includes('AUTH_ERROR'));

  res.json({
    configured: config.isConfigured(),
    connected: !!user,
    tokenStatus,
    expiresInDays: expiresInDays !== null ? Number(expiresInDays.toFixed(1)) : null,
    expiresAt: user?.expires_at || null,
    needsReauth: needsReauth || authErrors.length > 0,
    authErrors,
    pages: pages.map(p => ({ ...p, tokenExpiresAt: p.token_expires_at })),
    syncStates,
    isDemo,
    requiredPermissions: config.requiredPermissions
  });
});

router.post('/logout', (req, res) => {
  res.clearCookie('turnip_auth');
  res.json({ ok: true });
});

// Dev helper: clear demo data
router.post('/clear-demo', (req, res) => {
  const db = getDb();
  db.prepare(`DELETE FROM insights WHERE post_id IN (SELECT id FROM posts WHERE page_id IN (SELECT id FROM pages WHERE access_token='DEMO_TOKEN_NOT_REAL'))`).run();
  db.prepare(`DELETE FROM posts WHERE page_id IN (SELECT id FROM pages WHERE access_token='DEMO_TOKEN_NOT_REAL')`).run();
  db.prepare(`DELETE FROM pages WHERE access_token='DEMO_TOKEN_NOT_REAL'`).run();
  db.prepare(`DELETE FROM sync_state WHERE page_id IN ('111111111111111','222222222222222')`).run();
  res.json({ ok: true });
});

function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

export default router;
