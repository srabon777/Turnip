import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  fbAppId: process.env.FB_APP_ID || '',
  fbAppSecret: process.env.FB_APP_SECRET || '',
  fbRedirectUri: process.env.FB_REDIRECT_URI || 'http://localhost:3000/api/auth/callback',
  fbGraphVersion: process.env.FB_GRAPH_VERSION || 'v19.0',
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  dbPath: process.env.DB_PATH || 'data/turnip.db',
  // permissions required for this app (development-mode)
  requiredPermissions: [
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_posts',
    'read_insights',
    'pages_read_user_content'
  ],
  graphBase: (version) => `https://graph.facebook.com/${version || process.env.FB_GRAPH_VERSION || 'v19.0'}`,
  isConfigured: function () {
    return Boolean(this.fbAppId && this.fbAppSecret);
  }
};
