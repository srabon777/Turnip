import { Router } from 'express';
import { getDb } from '../db.js';
import { getReelPerformance, computeAverages, getHistoricalSeries, syncPageInsights } from '../services/insights.js';
import { getBestTimeRecommendations } from '../services/recommendations.js';

const router = Router();

router.get('/pages/:pageId/reels', (req, res) => {
  const { pageId } = req.params;
  const db = getDb();
  const page = db.prepare('SELECT id, name FROM pages WHERE id=?').get(pageId);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  const reels = getReelPerformance(pageId);
  const averages = computeAverages(pageId);
  res.json({ page, reels, averages, count: reels.length });
});

router.get('/pages/:pageId/recommendations', (req, res) => {
  const { pageId } = req.params;
  const db = getDb();
  const page = db.prepare('SELECT id FROM pages WHERE id=?').get(pageId);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  const rec = getBestTimeRecommendations(pageId);
  res.json(rec);
});

router.get('/pages/:pageId/series', (req, res) => {
  const { pageId } = req.params;
  const series = getHistoricalSeries(pageId);
  res.json(series);
});

router.post('/pages/:pageId/sync', async (req, res) => {
  const { pageId } = req.params;
  const db = getDb();
  const page = db.prepare('SELECT access_token FROM pages WHERE id=?').get(pageId);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  if (!page.access_token || page.access_token === 'DEMO_TOKEN_NOT_REAL') {
    return res.status(400).json({ error: 'Demo page — connect a real Facebook Page via Login to sync.' });
  }
  try {
    const result = await syncPageInsights(pageId, page.access_token);
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: `Token invalid/expired: ${e.message}`, needsReauth: true });
    if (e.isRateLimit) return res.status(429).json({ error: 'Rate limited by Facebook — retry in a minute.', retryable: true });
    res.status(500).json({ error: e.message });
  }
});

router.get('/overview', (req, res) => {
  const db = getDb();
  const pages = db.prepare('SELECT id, name FROM pages').all();
  const overview = pages.map(p => {
    const reels = getReelPerformance(p.id);
    const avg = computeAverages(p.id);
    const totalViews = reels.reduce((s, r) => s + (r.post_video_views || 0), 0);
    const totalReach = reels.reduce((s, r) => s + (r.post_reach || 0), 0);
    return { page: p, count: reels.length, totalViews, totalReach, averages: avg, latest: reels[0] || null };
  });
  res.json(overview);
});

export default router;
