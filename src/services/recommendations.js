import { getDb } from '../db.js';

/**
 * Best-time-to-post — computed strictly from the page's own historical data.
 * We bucket posts by (dayOfWeek, hour) and score by median views / engagement.
 * Returns a ranked list + a 7x24 heatmap.
 */
export function getBestTimeRecommendations(pageId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT p.created_time as created_time,
           i.post_video_views as views,
           i.post_reach as reach,
           i.like_count, i.comment_count, i.share_count
    FROM posts p
    JOIN insights i ON i.post_id = p.id
    WHERE p.page_id = ?
      AND i.fetched_at = (SELECT MAX(fetched_at) FROM insights WHERE post_id = i.post_id)
  `).all(pageId);

  if (rows.length < 5) {
    return {
      insufficientData: true,
      message: `Only ${rows.length} posts with metrics — need at least 5 to compute recommendations. Post more and sync again.`,
      heatmap: emptyHeatmap(),
      topSlots: []
    };
  }

  // Build heatmap: dow 0-6 (Sun-Sat), hour 0-23
  const buckets = new Map(); // key `${dow}-${hour}` -> { views:[], eng:[], count }
  for (const r of rows) {
    const d = new Date(r.created_time);
    const dow = d.getDay();
    const hour = d.getHours();
    const key = `${dow}-${hour}`;
    if (!buckets.has(key)) buckets.set(key, { views: [], eng: [], hours: [] });
    const b = buckets.get(key);
    b.views.push(r.views || 0);
    const eng = r.reach ? (r.like_count + r.comment_count + r.share_count) / r.reach : 0;
    b.eng.push(eng);
  }

  // Score each bucket: weighted combo of median views and median engagement
  const slots = [];
  for (const [key, b] of buckets) {
    const [dow, hour] = key.split('-').map(Number);
    const medViews = median(b.views);
    const medEng = median(b.eng);
    const score = medViews * 0.7 + medEng * 10000 * 0.3; // normalize eng to comparable scale
    slots.push({ dow, hour, count: b.views.length, medianViews: Math.round(medViews), medianEngagement: medEng, score });
  }
  slots.sort((a, b) => b.score - a.score);

  // Also build full heatmap matrix for UI
  const heatmap = emptyHeatmap();
  for (const s of slots) {
    heatmap[s.dow][s.hour] = { views: s.medianViews, count: s.count, score: s.score };
  }
  // Normalize scores 0-1 for color scale
  const maxScore = Math.max(...slots.map(s => s.score), 1);
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
    const cell = heatmap[d][h];
    if (cell) cell.norm = cell.score ? cell.score / maxScore : 0;
  }

  return {
    insufficientData: false,
    totalPosts: rows.length,
    topSlots: slots.slice(0, 6).map(s => ({
      ...s,
      label: `${DAY_NAMES[s.dow]} ${String(s.hour).padStart(2, '0')}:00`,
      reason: `Median ${s.medianViews.toLocaleString()} views across ${s.count} post(s) in this slot`
    })),
    heatmap,
    allSlots: slots
  };
}

function emptyHeatmap() {
  return Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => null));
}
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export { DAY_NAMES };
