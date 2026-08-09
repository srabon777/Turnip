# Turnip — Facebook Reels Studio

Personal analytics + scheduling dashboard for **your own Facebook Pages** — a VidIQ-style tool, but for Facebook Reels. For **personal use on Pages you administer** only. Development-mode Graph API access is sufficient; no App Review required for that use case.

![Turnip](public/styles.css)

---

## What it does (priority order)

1. **OAuth login** — Facebook Login for your account, stores a **long-lived Page Access Token** per Page (~60-day expiry) and auto-refreshes when < 7 days remain. Clear **re-auth prompt** if refresh fails — never silent.
2. **Historical insights** — Pulls per-post metrics (`post_video_views`, `post_video_avg_time_watched`, `post_video_complete_views_organic`, `post_impressions`, `reach`, `engagement`) on a **daily schedule (02:30)** + on-demand “Sync now”, and **persists locally in SQLite**. Meta only exposes a limited recent window, so history is never re-fetched — it's accumulated.
3. **Per-Reel performance** — Views, avg watch time, retention (complete/ views), engagement rate `(likes+comments+shares)/reach`, and **vs your own page’s historical average** (not industry benchmarks).
4. **Best-time-to-post** — Computed **only from your own historical data** (median views + engagement per day-of-week × hour bucket), with a ranked Top 6 list and a 7×24 heatmap. Shows “insufficient data” until ≥5 posts.
5. **Reel composer** — Schedule a Reel (video file upload + caption + scheduled time) via the Graph API (`/{page-id}/videos` / `/{page-id}/video_reels` with `scheduled_publish_time` + `published=false`). “Publish now” if no time is set.

**Explicitly not built** (by design): competitor analysis, tag/keyword scoring, multi-user support — these either have no Facebook API equivalent or would require App Review.

---

## Facebook App permissions you must request

Create an app at <https://developers.facebook.com/> → **Add Product: Facebook Login** → set Valid OAuth Redirect URI to your `FB_REDIRECT_URI`.

Request these **permissions** (under App → Permissions / Login → Permissions). In **Development Mode** you can grant them to yourself immediately; for anyone else you’d need App Review (see warning below).

| Permission | Why Turnip needs it |
|---|---|
| `pages_show_list` | List Pages you administer |
| `pages_read_engagement` | Read Page + post engagement data |
| `pages_read_user_content` | Read posts created on the Page |
| `pages_manage_posts` | Create / schedule Reels & posts on your Pages |
| `read_insights` | Read post/video insights (views, avg watch, reach, etc.) |

> In the OAuth dialog Turnip requests exactly: `pages_show_list, pages_read_engagement, pages_manage_posts, read_insights, pages_read_user_content`. Remove any you don’t want in `src/config.js`.

Also enable: **Web OAuth Login** and **Enforce HTTPS** (for production) in Facebook Login settings.

---

## Running locally

### 1. Prerequisites

- Node 22+
- A Facebook Developer app (see above) — or run in **demo mode** with seeded data and no credentials.

### 2. Configure

```bash
cp .env.example .env
# edit .env — fill FB_APP_ID, FB_APP_SECRET, FB_REDIRECT_URI
```

`.env` is git-ignored. **Never commit it.** Tokens are stored server-side in `data/turnip.db` (also git-ignored), never in the repo.

Minimal `.env`:

```
FB_APP_ID=123456789012345
FB_APP_SECRET=abc… 
FB_REDIRECT_URI=http://localhost:3000/api/auth/callback
FB_GRAPH_VERSION=v19.0
SESSION_SECRET=some-long-random-string
PORT=3000
```

### 3. Install & run

```bash
npm install
npm start
# open http://localhost:3000
```

On first boot with no `.env`, the app seeds **2 demo Pages + 24 Reels** so the dashboard is immediately usable. Click **Connect Facebook** to replace demo data with your real Pages.

For live-reload during development:

```bash
npm run dev
```

### 4. Daily sync

- A cron job fires **daily at 02:30** (`src/services/scheduler.js`) — pulls insights for every connected Page and appends a new `insights` row per post (historical).
- Use **Sync now** in the UI or `POST /api/insights/pages/:pageId/sync` for on-demand pulls.
- **Manual backfill**: call `POST /api/insights/pages/:pageId/sync` repeatedly; paging fetches up to 50 recent posts per call.

---

## Architecture & technical constraints

```
src/services/facebook.js   ← all Graph API calls isolated here
  ├─ graphFetch() with exponential backoff + Retry-After respect
  ├─ distinct errors: isRateLimit (code 4 / 429) vs isAuthError (code 190 / 401)
  └─ easy to patch when Meta changes fields/permissions

src/services/insights.js   ← sync + historical queries
src/services/recommendations.js ← best-time from own data only
src/services/scheduler.js  ← daily cron + token refresh (<7d)
src/db.js                  ← SQLite (node:sqlite) — data/turnip.db
  tables: pages, user_tokens, posts, insights (append-only), sync_state

src/routes/auth.js         ← OAuth login, token exchange, extend, status
src/routes/pages.js        ← list / refresh pages
src/routes/insights.js     ← reels, recommendations, series, sync
src/routes/composer.js     ← Reel upload/schedule (multipart)

public/                    ← vanilla SPA: dashboard, heatmap, composer
```

- **Rate limits**: `graphFetch()` honors `Retry-After` and backs off `2^attempt` seconds, up to 3 retries; scheduler staggers pages by 2s and posts by 350ms.
- **Expired tokens**: `FacebookApiError.isAuthError` bubbles to the UI as a **re-auth banner** (`GET /api/auth/status` → `needsReauth`) and `401` on mutating routes. Tokens are refreshed via `fb_exchange_token` when < 7 days remain; page tokens are re-fetched via `/me/accounts` after refresh. If refresh fails, `sync_state.last_error` records `AUTH_ERROR`.
- **Credentials**: `FB_APP_SECRET` in `.env` only; page/user tokens in SQLite, never committed. `.env` + `data/*.db` are in `.gitignore`.
- **Graph API drift**: all field names / metrics live in `facebook.js` (`getPostInsights` metrics list, `getPagePosts` fields). Patching that one file updates the whole app.

### Graph API notes

- Reels insights require the post to be a video post; non-video posts return empty insights gracefully.
- Scheduling requires `scheduled_publish_time` (unix seconds, ≥10 min future, ≤75 days) + `published=false`.
- The code tries `POST /{page-id}/video_reels` first, falling back to `POST /{page-id}/videos` — both are isolated in `facebook.js` for easy swap when Meta renames endpoints.

---

## API quick reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/auth/login` | Redirect to Facebook OAuth |
| `GET` | `/api/auth/callback` | OAuth callback — exchanges code, extends token, stores Pages |
| `GET` | `/api/auth/status` | Token expiry, pages, sync errors, `needsReauth` |
| `GET` | `/api/pages` | List Pages |
| `POST` | `/api/pages/refresh` | Re-fetch Pages via `/me/accounts` |
| `GET` | `/api/insights/pages/:id/reels` | Reels + vs-average |
| `GET` | `/api/insights/pages/:id/recommendations` | Best-time slots + heatmap |
| `POST` | `/api/insights/pages/:id/sync` | Pull insights now (with backoff) |
| `POST` | `/api/composer/pages/:id/reels` | `multipart: video, caption, file_url, scheduled_time` |
| `GET` | `/api/health` | Liveness + `configured` flag |

---

## ⚠️ Public / multi-user warning

> **This app is intentionally single-user / development-mode.** If you ever want to let *other* people connect *their* Pages, you **must** submit for **Meta App Review** and **Business Verification** and request the same permissions at: <https://developers.facebook.com/docs/app-review>. Do **not** attempt to build around that requirement (e.g. asking users to paste tokens, scraping, or proxying). The isolated `facebook.js` module makes it straightforward to add review-required scopes later, but the review itself cannot be bypassed.

---

## License

Personal use. Not for redistribution as a public SaaS without completing App Review.
