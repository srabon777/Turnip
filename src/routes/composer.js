import { Router } from 'express';
import multer from 'multer';
import { getDb } from '../db.js';
import { createReel, uploadReelVideo } from '../services/facebook.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } }); // 200MB

// Schedule a Reel — either file upload or file_url
router.post('/pages/:pageId/reels', upload.single('video'), async (req, res) => {
  const { pageId } = req.params;
  const { caption = '', scheduled_time, file_url } = req.body;

  const db = getDb();
  const page = db.prepare('SELECT access_token FROM pages WHERE id=?').get(pageId);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  if (!page.access_token || page.access_token === 'DEMO_TOKEN_NOT_REAL') {
    return res.status(400).json({ error: 'Demo page — connect a real Page to publish.' });
  }
  if (!req.file && !file_url) {
    return res.status(400).json({ error: 'Provide a video file or file_url' });
  }

  let scheduledPublishTime = null;
  if (scheduled_time) {
    const d = new Date(scheduled_time);
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid scheduled_time (use ISO 8601)' });
    // Facebook requires 10 min to 75 days in future for scheduled posts
    const now = Date.now();
    const diff = d.getTime() - now;
    if (diff < 10 * 60 * 1000) return res.status(400).json({ error: 'scheduled_time must be at least 10 minutes in the future' });
    if (diff > 75 * 24 * 60 * 60 * 1000) return res.status(400).json({ error: 'scheduled_time must be within 75 days' });
    scheduledPublishTime = Math.floor(d.getTime() / 1000);
  }

  try {
    let result;
    if (req.file) {
      result = await uploadReelVideo({
        pageId, pageToken: page.access_token,
        fileBuffer: req.file.buffer, filename: req.file.originalname || 'reel.mp4',
        caption, scheduledPublishTime
      });
    } else {
      result = await createReel({
        pageId, pageToken: page.access_token,
        caption, videoUrl: file_url, scheduledPublishTime
      });
    }

    // Store scheduled post locally for history even before it publishes
    const localId = result.id || `scheduled_${Date.now()}`;
    db.prepare(`
      INSERT OR IGNORE INTO posts (id, page_id, message, created_time, type, is_reel, scheduled_publish_time, status)
      VALUES (?, ?, ?, ?, 'video', 1, ?, ?)
    `).run(localId, pageId, caption, new Date().toISOString(), scheduledPublishTime, scheduledPublishTime ? 'scheduled' : 'published');

    res.json({ ok: true, result, scheduled: !!scheduledPublishTime });
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: `Token invalid/expired: ${e.message}`, needsReauth: true });
    if (e.isRateLimit) return res.status(429).json({ error: 'Rate limited — wait a minute and retry.' });
    res.status(500).json({ error: e.message });
  }
});

// List scheduled posts (local)
router.get('/pages/:pageId/scheduled', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM posts WHERE page_id=? AND status='scheduled' ORDER BY scheduled_publish_time ASC`).all(req.params.pageId);
  res.json(rows);
});

export default router;
