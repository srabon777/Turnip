import { getDb } from '../db.js';
import { getPostInsights, getPostEngagement, getPagePosts, FacebookApiError } from './facebook.js';

export async function syncPageInsights(pageId, pageToken) {
  const db = getDb();
  let nextUrl = null;
  let fetched = 0;
  let errors = [];

  // Fetch recent posts via paging (1-2 pages is enough daily; we cap at 50 posts)
  let pagingData;
  try {
    pagingData = await getPagePosts(pageId, pageToken, { limit: 25 });
  } catch (e) {
    if (e.isAuthError) throw e;
    throw e;
  }

  const allPosts = [...(pagingData.data || [])];
  // naive: fetch second page if available (up to 50)
  if (pagingData.paging?.next && allPosts.length < 50) {
    try {
      const nextRes = await fetch(pagingData.paging.next);
      const j = await nextRes.json();
      if (j.data) allPosts.push(...j.data.slice(0, 25));
    } catch { /* ignore paging error */ }
  }

  for (const post of allPosts) {
    try {
      // Upsert post row
      const isReel = post.type === 'video' || post.attachments?.data?.some(a => a.media_type === 'video') ? 1 : 0;
      db.prepare(`
        INSERT INTO posts (id, page_id, message, permalink_url, created_time, type, is_reel, thumbnail_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          message=excluded.message,
          permalink_url=excluded.permalink_url,
          type=excluded.type,
          is_reel=excluded.is_reel
      `).run(
        post.id, pageId, post.message || '', post.permalink_url || `https://facebook.com/${post.id}`,
        post.created_time || new Date().toISOString(), post.type || 'post', isReel, post.full_picture || ''
      );

      // Fetch insights + engagement (isolated module handles retry/backoff)
      const [insights, engagement] = await Promise.all([
        getPostInsights(post.id, pageToken).catch(() => ({})),
        getPostEngagement(post.id, pageToken)
      ]);

      db.prepare(`
        INSERT INTO insights (post_id, fetched_at, post_video_views, post_video_avg_time_watched, post_impressions, post_reach, post_engaged_users, post_video_complete_views_organic, like_count, comment_count, share_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        post.id, Math.floor(Date.now() / 1000),
        insights.post_video_views || 0,
        insights.post_video_avg_time_watched || 0,
        insights.post_impressions || 0,
        insights.post_reach || 0,
        insights.post_engaged_users || 0,
        insights.post_video_complete_views_organic || 0,
        engagement.like_count || 0,
        engagement.comment_count || 0,
        engagement.share_count || 0
      );
      fetched++;
      // small delay to be gentle on rate limits
      await new Promise(r => setTimeout(r, 350));
    } catch (e) {
      if (e.isRateLimit) {
        // propagate rate limit so caller can back off globally
        throw e;
      }
      errors.push({ id: post.id, error: e.message });
    }
  }

  db.prepare(`INSERT OR REPLACE INTO sync_state (page_id, last_sync_at, last_error) VALUES (?, ?, ?)`)
    .run(pageId, Math.floor(Date.now() / 1000), errors.length ? JSON.stringify(errors.slice(0, 3)) : null);

  return { fetched, total: allPosts.length, errors };
}

export function getReelPerformance(pageId) {
  const db = getDb();
  // Join latest insight per post
  const rows = db.prepare(`
    SELECT p.id, p.message, p.permalink_url, p.created_time, p.is_reel, p.thumbnail_url,
           i.post_video_views, i.post_video_avg_time_watched, i.post_impressions, i.post_reach,
           i.post_engaged_users, i.like_count, i.comment_count, i.share_count, i.fetched_at,
           i.post_video_complete_views_organic
    FROM posts p
    LEFT JOIN (
      SELECT post_id, MAX(fetched_at) as max_fetched FROM insights GROUP BY post_id
    ) latest ON latest.post_id = p.id
    LEFT JOIN insights i ON i.post_id = p.id AND i.fetched_at = latest.max_fetched
    WHERE p.page_id = ?
    ORDER BY datetime(p.created_time) DESC
    LIMIT 100
  `).all(pageId);

  // Compute page averages for comparison
  const avg = computeAverages(pageId);

  return rows.map(r => {
    const views = r.post_video_views || 0;
    const avgWatch = r.post_video_avg_time_watched || 0;
    const reach = r.post_reach || 0;
    const engaged = r.post_engaged_users || 0;
    const likes = r.like_count || 0, comments = r.comment_count || 0, shares = r.share_count || 0;
    const engagement = reach ? ((likes + comments + shares) / reach) : 0;
    const retention = views && r.post_video_complete_views_organic ? (r.post_video_complete_views_organic / views) : null;
    return {
      ...r,
      engagement_rate: engagement,
      retention_rate: retention,
      vs_avg_views: avg.avg_views ? (views - avg.avg_views) / avg.avg_views : 0,
      vs_avg_engagement: avg.avg_engagement ? (engagement - avg.avg_engagement) / (avg.avg_engagement || 1) : 0,
      page_avg: avg
    };
  });
}

export function computeAverages(pageId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT AVG(i.post_video_views) as avg_views,
           AVG(i.post_video_avg_time_watched) as avg_watch,
           AVG(i.post_reach) as avg_reach,
           AVG(CAST(i.like_count + i.comment_count + i.share_count AS REAL) / NULLIF(i.post_reach,0)) as avg_engagement,
           COUNT(*) as n
    FROM insights i
    JOIN posts p ON p.id = i.post_id
    WHERE p.page_id = ?
      AND i.fetched_at = (SELECT MAX(fetched_at) FROM insights WHERE post_id = i.post_id)
  `).get(pageId);
  return {
    avg_views: row?.avg_views || 0,
    avg_watch: row?.avg_watch || 0,
    avg_reach: row?.avg_reach || 0,
    avg_engagement: row?.avg_engagement || 0,
    n: row?.n || 0
  };
}

export function getHistoricalSeries(pageId, days = 30) {
  const db = getDb();
  // Returns daily aggregated views
  const rows = db.prepare(`
    SELECT date(p.created_time) as d, COUNT(*) as posts,
           AVG(i.post_video_views) as avg_views,
           SUM(i.post_video_views) as total_views
    FROM posts p
    JOIN insights i ON i.post_id = p.id
    WHERE p.page_id = ?
      AND i.fetched_at = (SELECT MAX(fetched_at) FROM insights WHERE post_id = i.post_id)
    GROUP BY date(p.created_time)
    ORDER BY d ASC
  `).all(pageId);
  return rows;
}
