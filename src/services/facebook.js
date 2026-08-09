/**
 * facebook.js — isolated Graph API module.
 * All direct calls to https://graph.facebook.com live here so permission/field
 * changes can be patched without touching the rest of the app.
 *
 * Design notes:
 * - Handles rate limits with exponential backoff + Retry-After.
 * - Surfaces OAuth token errors distinctly so callers can prompt re-auth.
 */
import { config } from '../config.js';

const GRAPH_VERSION = config.fbGraphVersion;

// ---------- low-level fetch with retry ----------
export class FacebookApiError extends Error {
  constructor(message, { status, code, subcode, type, isRateLimit, isAuthError, retryAfter } = {}) {
    super(message);
    this.name = 'FacebookApiError';
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.type = type;
    this.isRateLimit = isRateLimit;
    this.isAuthError = isAuthError;
    this.retryAfter = retryAfter;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function graphFetch(path, { token, params = {}, method = 'GET', body, timeoutMs = 15000 } = {}) {
  const url = new URL(`${config.graphBase(GRAPH_VERSION)}${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  if (token) url.searchParams.set('access_token', token);

  const opts = { method, headers: {} };
  if (body) {
    if (body instanceof FormData) opts.body = body;
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }

  // Retry up to 3 times on rate-limit / transient 5xx
  let attempt = 0;
  while (true) {
    attempt++;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url.toString(), { ...opts, signal: controller.signal });
    } catch (e) {
      clearTimeout(t);
      if (attempt < 3) { await sleep(1000 * attempt); continue; }
      throw new FacebookApiError(`Network error: ${e.message}`, { isRateLimit: false });
    }
    clearTimeout(t);

    const retryAfterHeader = res.headers.get('retry-after');
    let data;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

    if (res.ok) return data;

    const err = data?.error || {};
    const code = err.code;
    const subcode = err.error_subcode;
    const isRateLimit = code === 4 || code === 80004 || res.status === 429 || err.type === 'OAuthException' && /rate limit/i.test(err.message || '');
    const isAuthError = code === 190 || res.status === 401 || res.status === 403 && /access token/i.test(err.message || '');

    if (isRateLimit && attempt < 4) {
      const retryAfter = parseInt(retryAfterHeader || err.retry_after || '0', 10);
      const backoff = retryAfter ? retryAfter * 1000 : Math.pow(2, attempt) * 1000 + Math.random() * 500;
      console.warn(`[facebook] rate-limited (code ${code}), retry ${attempt}/3 after ${Math.round(backoff)}ms`);
      await sleep(Math.min(backoff, 30000));
      continue;
    }

    throw new FacebookApiError(err.message || `Graph API ${res.status}`, {
      status: res.status, code, subcode, type: err.type, isRateLimit, isAuthError,
      retryAfter: retryAfterHeader
    });
  }
}

// ---------- OAuth helpers ----------
export function getLoginUrl(state) {
  const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', config.fbAppId);
  url.searchParams.set('redirect_uri', config.fbRedirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', config.requiredPermissions.join(','));
  url.searchParams.set('response_type', 'code');
  return url.toString();
}

export async function exchangeCodeForToken(code) {
  const data = await graphFetch('/oauth/access_token', {
    params: {
      client_id: config.fbAppId,
      client_secret: config.fbAppSecret,
      redirect_uri: config.fbRedirectUri,
      code
    }
  });
  return data; // { access_token, token_type, expires_in }
}

export async function extendAccessToken(shortLivedToken) {
  // Exchange short-lived user token for long-lived (~60 days)
  const data = await graphFetch('/oauth/access_token', {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: config.fbAppId,
      client_secret: config.fbAppSecret,
      fb_exchange_token: shortLivedToken
    }
  });
  return data; // { access_token, expires_in }
}

export async function getDebugToken(inputToken) {
  // Requires app token; useful to check expiry
  const appToken = `${config.fbAppId}|${config.fbAppSecret}`;
  return graphFetch('/debug_token', { params: { input_token: inputToken }, token: appToken });
}

// ---------- Page + insights helpers ----------
export async function getPages(userToken) {
  const data = await graphFetch('/me/accounts', {
    token: userToken,
    params: { fields: 'id,name,access_token,category', limit: 50 }
  });
  return data.data || [];
}

export async function getPagePosts(pageId, pageToken, { limit = 25, since, until } = {}) {
  const params = {
    fields: 'id,message,permalink_url,created_time,type,status_type,full_picture,attachments{media_type,media,url}',
    limit
  };
  if (since) params.since = since;
  if (until) params.until = until;
  const data = await graphFetch(`/${pageId}/posts`, { token: pageToken, params });
  return data;
}

export async function getPostInsights(postId, pageToken) {
  // Metrics requested per spec; not all posts have video metrics — we handle missing gracefully.
  const metrics = [
    'post_video_views',
    'post_video_avg_time_watched',
    'post_video_complete_views_organic',
    'post_impressions',
    'post_reach',
    'post_engaged_users'
  ].join(',');
  try {
    const data = await graphFetch(`/${postId}/insights`, {
      token: pageToken,
      params: { metric: metrics }
    });
    // Graph returns { data: [{ name, period, values:[{value}], ... }] }
    const map = {};
    for (const row of (data.data || [])) {
      const v = row.values?.[0]?.value;
      map[row.name] = typeof v === 'number' ? v : (v ?? 0);
    }
    return map;
  } catch (e) {
    if (e.code === 100) return {}; // unsupported metric for this post type
    throw e;
  }
}

export async function getPostEngagement(postId, pageToken) {
  // likes/comments/shares via fields on the post itself
  try {
    const data = await graphFetch(`/${postId}`, {
      token: pageToken,
      params: { fields: 'likes.summary(true),comments.summary(true),shares' }
    });
    return {
      like_count: data.likes?.summary?.total_count ?? 0,
      comment_count: data.comments?.summary?.total_count ?? 0,
      share_count: data.shares?.count ?? 0
    };
  } catch { return { like_count: 0, comment_count: 0, share_count: 0 }; }
}

// ---------- Reels composer ----------
export async function createReel({ pageId, pageToken, caption, videoUrl, scheduledPublishTime }) {
  // For file uploads, callers should use uploadReelVideo instead.
  const params = { description: caption };
  if (scheduledPublishTime) {
    params.published = false;
    params.scheduled_publish_time = scheduledPublishTime;
  }
  // URL-based upload (simpler for API testing)
  if (videoUrl) params.file_url = videoUrl;

  // Reels endpoint; falls back to /videos if not available
  try {
    return await graphFetch(`/${pageId}/video_reels`, { token: pageToken, method: 'POST', params });
  } catch (e) {
    // Fallback to generic video endpoint (still creates a Reel if vertical)
    return await graphFetch(`/${pageId}/videos`, { token: pageToken, method: 'POST', params });
  }
}

export async function uploadReelVideo({ pageId, pageToken, fileBuffer, filename, caption, scheduledPublishTime }) {
  const form = new FormData();
  form.append('source', new Blob([fileBuffer]), filename);
  form.append('description', caption || '');
  if (scheduledPublishTime) {
    form.append('published', 'false');
    form.append('scheduled_publish_time', String(scheduledPublishTime));
  }
  const url = new URL(`${config.graphBase(GRAPH_VERSION)}/${pageId}/videos`);
  url.searchParams.set('access_token', pageToken);
  const res = await fetch(url.toString(), { method: 'POST', body: form });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = data?.error || {};
    throw new FacebookApiError(err.message || `Upload failed ${res.status}`, {
      status: res.status, code: err.code, isAuthError: err.code === 190, isRateLimit: err.code === 4
    });
  }
  return data;
}
