import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let db;

export function getDb() {
  if (db) return db;
  const dbPath = config.dbPath;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  // WAL for better concurrency
  db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

export function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      access_token TEXT NOT NULL,
      token_expires_at INTEGER,
      category TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_tokens (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      access_token TEXT NOT NULL,
      expires_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL REFERENCES pages(id),
      message TEXT,
      permalink_url TEXT,
      created_time TEXT,
      type TEXT,
      is_reel INTEGER DEFAULT 0,
      scheduled_publish_time INTEGER,
      status TEXT DEFAULT 'published',
      thumbnail_url TEXT,
      FOREIGN KEY(page_id) REFERENCES pages(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      fetched_at INTEGER NOT NULL,
      post_video_views INTEGER DEFAULT 0,
      post_video_avg_time_watched REAL DEFAULT 0,
      post_impressions INTEGER DEFAULT 0,
      post_reach INTEGER DEFAULT 0,
      post_engaged_users INTEGER DEFAULT 0,
      post_video_complete_views_organic INTEGER DEFAULT 0,
      like_count INTEGER DEFAULT 0,
      comment_count INTEGER DEFAULT 0,
      share_count INTEGER DEFAULT 0,
      UNIQUE(post_id, fetched_at)
    );
    CREATE TABLE IF NOT EXISTS sync_state (
      page_id TEXT PRIMARY KEY,
      last_sync_at INTEGER,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_posts_page ON posts(page_id);
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_time);
    CREATE INDEX IF NOT EXISTS idx_insights_post ON insights(post_id);
  `);
}

// Seed demo data if DB is empty — lets the UI be useful without real FB creds
export function seedIfEmpty() {
  const database = getDb();
  const count = database.prepare('SELECT COUNT(*) as c FROM pages').get();
  if (count.c > 0) return false;

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  const pages = [
    { id: '111111111111111', name: 'Tech Byte — Daily', category: 'Science & Tech' },
    { id: '222222222222222', name: 'Meme Vault — Shorts', category: 'Comedy' }
  ];
  for (const p of pages) {
    database.prepare(`INSERT INTO pages (id, name, access_token, token_expires_at, category, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(p.id, p.name, 'DEMO_TOKEN_NOT_REAL', Math.floor((now + 50 * day) / 1000), p.category, Math.floor(now / 1000));
    database.prepare(`INSERT OR REPLACE INTO sync_state (page_id, last_sync_at) VALUES (?, ?)`).run(p.id, Math.floor(now / 1000));
  }

  // Seeded posts: 24 reels over last 30 days, at varying hours
  let postIdx = 0;
  const rng = mulberry32(42);
  for (const page of pages) {
    for (let i = 0; i < 12; i++) {
      postIdx++;
      const daysAgo = Math.floor(rng() * 28) + 1;
      const hour = [8, 9, 12, 13, 17, 18, 19, 20, 21, 22][Math.floor(rng() * 10)];
      const d = new Date(now - daysAgo * day);
      d.setHours(hour, Math.floor(rng() * 60), 0, 0);
      const created = d.toISOString();
      const id = `${page.id}_post_${String(postIdx).padStart(4, '0')}`;
      const isReel = 1;
      const views = Math.floor(800 + rng() * 12000 + (hour >= 18 && hour <= 21 ? 3000 : 0) + (page.id === '111111111111111' ? 1500 : 0));
      const avgWatch = 3 + rng() * 12;
      const reach = Math.floor(views * (0.7 + rng() * 0.3));
      const likes = Math.floor(views * (0.02 + rng() * 0.05));
      const comments = Math.floor(likes * 0.1);
      const shares = Math.floor(likes * 0.05);
      const engaged = Math.floor(reach * 0.15);
      const impressions = Math.floor(reach * 1.2);

      database.prepare(`INSERT INTO posts (id, page_id, message, permalink_url, created_time, type, is_reel, thumbnail_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, page.id, sampleCaption(page.name, postIdx), `https://facebook.com/${page.id}/posts/${id}`, created, 'video', isReel, '');

      database.prepare(`INSERT INTO insights (post_id, fetched_at, post_video_views, post_video_avg_time_watched, post_impressions, post_reach, post_engaged_users, like_count, comment_count, share_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, Math.floor(now / 1000), views, Number(avgWatch.toFixed(2)), impressions, reach, engaged, likes, comments, shares);
    }
  }
  console.log('Seeded demo data: 2 pages, 24 reels');
  return true;
}

function sampleCaption(pageName, idx) {
  const tech = [
    "Why your phone battery dies at 20% — explained in 25s 🔋",
    "I tested 5 AI coding tools so you don't have to",
    "This CSS trick saved me 100 lines of code",
    "Apple vs Android — the one stat nobody mentions",
    "How I automated my entire morning routine"
  ];
  const meme = [
    "POV: you opened TikTok for 5 minutes 3 hours ago 😭",
    "My code at 2am vs my code at 2pm",
    "When the WiFi dies during a boss fight",
    "That one friend who replies with 'k'",
    "Me pretending I understood the meeting"
  ];
  const arr = pageName.includes('Tech') ? tech : meme;
  return arr[idx % arr.length] + ` #${idx}`;
}

function mulberry32(a) {
  return function () {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Allow `node src/db.js --seed`
if (process.argv.includes('--seed')) {
  seedIfEmpty();
}
