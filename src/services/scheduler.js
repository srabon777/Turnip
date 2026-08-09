import cron from 'node-cron';
import { getDb } from '../db.js';
import { syncPageInsights } from './insights.js';
import { extendAccessToken, getDebugToken } from './facebook.js';
import { config } from '../config.js';

let job = null;

export function startScheduler() {
  // Daily at 02:30 local time — pull insights. Also checks token expiry.
  if (job) return job;
  job = cron.schedule('30 2 * * *', async () => {
    console.log('[scheduler] daily sync tick');
    await runDailySync();
  });
  // Also run a check shortly after boot (30s) so first-time users see data quickly if already authed
  setTimeout(() => runDailySync().catch(e => console.error('[scheduler] boot sync failed', e.message)), 30_000);
  console.log('[scheduler] scheduled daily 02:30');
  return job;
}

export async function runDailySync() {
  const db = getDb();
  await refreshTokensIfNeeded();
  const pages = db.prepare('SELECT id, access_token FROM pages').all();
  for (const p of pages) {
    if (!p.access_token || p.access_token === 'DEMO_TOKEN_NOT_REAL') {
      console.log(`[sync] skipping ${p.id} (demo/no token)`);
      continue;
    }
    try {
      console.log(`[sync] syncing ${p.id} ...`);
      const result = await syncPageInsights(p.id, p.access_token);
      console.log(`[sync] ${p.id} done: ${result.fetched}/${result.total}`);
    } catch (e) {
      console.error(`[sync] ${p.id} failed:`, e.message);
      if (e.isAuthError) {
        db.prepare(`UPDATE sync_state SET last_error = ? WHERE page_id = ?`).run(`AUTH_ERROR: ${e.message} — re-auth required`, p.id);
      } else {
        db.prepare(`INSERT OR REPLACE INTO sync_state (page_id, last_sync_at, last_error) VALUES (?, ?, ?)`)
          .run(p.id, Math.floor(Date.now() / 1000), e.message.slice(0, 500));
      }
    }
    // stagger to avoid rate limits
    await new Promise(r => setTimeout(r, 2000));
  }
}

async function refreshTokensIfNeeded() {
  if (!config.isConfigured()) return;
  const db = getDb();
  const row = db.prepare('SELECT access_token, expires_at FROM user_tokens WHERE id = 1').get();
  if (!row) return;
  const expiresAt = row.expires_at; // seconds epoch
  if (!expiresAt) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const daysLeft = (expiresAt - nowSec) / 86400;
  console.log(`[token] user token expires in ${daysLeft.toFixed(1)} days`);
  if (daysLeft < 7) {
    console.log('[token] refreshing — less than 7 days left');
    try {
      const data = await extendAccessToken(row.access_token);
      const newExpires = Math.floor(Date.now() / 1000) + (data.expires_in || 5184000);
      db.prepare('UPDATE user_tokens SET access_token = ?, expires_at = ?, updated_at = ? WHERE id = 1')
        .run(data.access_token, newExpires, Math.floor(Date.now() / 1000));
      console.log(`[token] refreshed, new expiry ~${((newExpires - nowSec) / 86400).toFixed(1)} days`);

      // Also refresh page tokens derived from new user token
      const { getPages } = await import('./facebook.js');
      const pages = await getPages(data.access_token);
      for (const pg of pages) {
        db.prepare(`UPDATE pages SET access_token = ?, updated_at = ? WHERE id = ?`).run(pg.access_token, Math.floor(Date.now() / 1000), pg.id);
      }
    } catch (e) {
      console.error('[token] refresh failed — re-auth required:', e.message);
      db.prepare(`UPDATE sync_state SET last_error = ? WHERE page_id = ?`).run(`TOKEN_REFRESH_FAILED: ${e.message}`, 'system');
    }
  }
}
