-- migrations/0001_initial_schema.sql
-- CloudComments Database Schema

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin')),
  avatar_url TEXT,
  bio TEXT,
  website TEXT,
  reputation INTEGER DEFAULT 0,
  email_notifications BOOLEAN DEFAULT 1,
  created_at TEXT NOT NULL,
  last_login TEXT,
  is_banned BOOLEAN DEFAULT 0,
  ban_reason TEXT,
  two_factor_secret TEXT,
  recovery_codes TEXT
);

-- Sites table
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  api_key TEXT UNIQUE NOT NULL,
  webhook_url TEXT,
  webhook_events TEXT DEFAULT 'comment.created,comment.updated,comment.deleted',
  moderation_enabled BOOLEAN DEFAULT 1,
  auto_approve_threshold INTEGER DEFAULT 30,
  spam_filter_enabled BOOLEAN DEFAULT 1,
  require_auth BOOLEAN DEFAULT 0,
  allowed_domains TEXT,
  blocked_words TEXT,
  custom_css TEXT,
  language TEXT DEFAULT 'en',
  timezone TEXT DEFAULT 'UTC',
  created_at TEXT NOT NULL,
  monthly_views INTEGER DEFAULT 0,
  total_comments INTEGER DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Comments table
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  post_slug TEXT NOT NULL,
  post_title TEXT,
  user_id INTEGER NOT NULL,
  parent_id INTEGER,
  content TEXT NOT NULL,
  content_html TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'spam', 'deleted')),
  spam_score INTEGER DEFAULT 0,
  ip_address TEXT,
  user_agent TEXT,
  edited_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  likes INTEGER DEFAULT 0,
  flags INTEGER DEFAULT 0,
  FOREIGN KEY (site_id) REFERENCES sites(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (parent_id) REFERENCES comments(id)
);

-- Comment likes table
CREATE TABLE IF NOT EXISTS comment_likes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE(comment_id, user_id)
);

-- Comment flags table
CREATE TABLE IF NOT EXISTS comment_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  resolved BOOLEAN DEFAULT 0,
  resolved_by INTEGER,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (resolved_by) REFERENCES users(id)
);

-- User sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Site moderators table
CREATE TABLE IF NOT EXISTS site_moderators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  permissions TEXT DEFAULT 'moderate_comments',
  added_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (added_by) REFERENCES users(id),
  UNIQUE(site_id, user_id)
);

-- Audit log table
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id INTEGER,
  details TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Email verification tokens
CREATE TABLE IF NOT EXISTS email_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Password reset tokens
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used BOOLEAN DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- API keys for programmatic access
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT UNIQUE NOT NULL,
  permissions TEXT DEFAULT 'read',
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Webhooks log
CREATE TABLE IF NOT EXISTS webhook_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  attempts INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);

-- Analytics events
CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  post_slug TEXT,
  user_id INTEGER,
  ip_address TEXT,
  user_agent TEXT,
  referrer TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Indexes for performance
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_reputation ON users(reputation);
CREATE INDEX idx_sites_api_key ON sites(api_key);
CREATE INDEX idx_sites_user_id ON sites(user_id);
CREATE INDEX idx_comments_site_post ON comments(site_id, post_slug);
CREATE INDEX idx_comments_status ON comments(status);
CREATE INDEX idx_comments_user_id ON comments(user_id);
CREATE INDEX idx_comments_parent_id ON comments(parent_id);
CREATE INDEX idx_comments_created_at ON comments(created_at);
CREATE INDEX idx_comment_likes_comment ON comment_likes(comment_id);
CREATE INDEX idx_comment_likes_user ON comment_likes(user_id);
CREATE INDEX idx_comment_flags_comment ON comment_flags(comment_id);
CREATE INDEX idx_comment_flags_resolved ON comment_flags(resolved);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX idx_analytics_site_created ON analytics_events(site_id, created_at);

-- Full-text search virtual table
CREATE VIRTUAL TABLE IF NOT EXISTS comments_fts USING fts5(
  content,
  content_html,
  post_title,
  tokenize = 'porter unicode61'
);

-- Trigger to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS comments_fts_insert AFTER INSERT ON comments
BEGIN
  INSERT INTO comments_fts(rowid, content, content_html, post_title)
  VALUES (new.id, new.content, new.content_html, new.post_title);
END;

CREATE TRIGGER IF NOT EXISTS comments_fts_update AFTER UPDATE ON comments
BEGIN
  UPDATE comments_fts
  SET content = new.content,
      content_html = new.content_html,
      post_title = new.post_title
  WHERE rowid = new.id;
END;

CREATE TRIGGER IF NOT EXISTS comments_fts_delete AFTER DELETE ON comments
BEGIN
  DELETE FROM comments_fts WHERE rowid = old.id;
END;
