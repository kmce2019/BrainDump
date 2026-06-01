CREATE TABLE IF NOT EXISTS captures (
  id TEXT PRIMARY KEY,
  raw_text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'web',
  title TEXT,
  summary TEXT,
  type TEXT DEFAULT 'note',
  category TEXT,
  priority TEXT DEFAULT 'medium',
  due_date TEXT,
  status TEXT DEFAULT 'inbox',
  processing_status TEXT DEFAULT 'unprocessed',
  ai_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  external_user_id TEXT,
  external_chat_id TEXT,
  external_message_id TEXT,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capture_tags (
  capture_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (capture_id, tag_id)
);

CREATE TABLE IF NOT EXISTS action_items (
  id TEXT PRIMARY KEY,
  capture_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  due_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  enabled INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_captures_created_at ON captures(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_captures_type ON captures(type);
CREATE INDEX IF NOT EXISTS idx_captures_status ON captures(status);
CREATE INDEX IF NOT EXISTS idx_captures_source ON captures(source);
CREATE INDEX IF NOT EXISTS idx_action_items_capture_id ON action_items(capture_id);
