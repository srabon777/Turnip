import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { getDb, seedIfEmpty } from './db.js';
import authRoutes from './routes/auth.js';
import pagesRoutes from './routes/pages.js';
import insightsRoutes from './routes/insights.js';
import composerRoutes from './routes/composer.js';
import { startScheduler } from './services/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/pages', pagesRoutes);
app.use('/api/insights', insightsRoutes);
app.use('/api/composer', composerRoutes);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, configured: config.isConfigured(), version: config.fbGraphVersion });
});

// Serve frontend
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

const db = getDb();
seedIfEmpty();
startScheduler();

app.listen(config.port, '0.0.0.0', () => {
  console.log(`Turnip running on http://localhost:${config.port}`);
  if (!config.isConfigured()) {
    console.log('⚠  FB_APP_ID / FB_APP_SECRET not set — running in DEMO mode with seeded data. Set .env to connect real Pages.');
  } else {
    console.log(`FB App: ${config.fbAppId}  redirect: ${config.fbRedirectUri}`);
  }
});
