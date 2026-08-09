import { Router } from 'express';
import { getDb } from '../db.js';
import { getPages as fetchPages } from '../services/facebook.js';

const router = Router();

router.get('/', (req, res) => {
  const db = getDb();
  const pages = db.prepare('SELECT id, name, category, updated_at FROM pages ORDER BY name').all();
  res.json(pages);
});

router.post('/refresh', async (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT access_token FROM user_tokens WHERE id=1').get();
  if (!user?.access_token) return res.status(401).json({ error: 'Not connected — please log in via Facebook first.', needsReauth: true });
  try {
    const pages = await fetchPages(user.access_token);
    for (const p of pages) {
      db.prepare(`
        INSERT INTO pages (id, name, access_token, category, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, access_token=excluded.access_token, category=excluded.category, updated_at=excluded.updated_at
      `).run(p.id, p.name, p.access_token, p.category || '', Math.floor(Date.now() / 1000));
    }
    // remove demo stub if real pages present
    if (pages.length) db.prepare(`DELETE FROM pages WHERE access_token='DEMO_TOKEN_NOT_REAL'`).run();
    res.json({ ok: true, pages });
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: e.message, needsReauth: true });
    if (e.isRateLimit) return res.status(429).json({ error: 'Rate limited — try again shortly.' });
    res.status(500).json({ error: e.message });
  }
});

export default router;
