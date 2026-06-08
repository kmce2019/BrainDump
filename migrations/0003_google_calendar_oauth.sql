CREATE TABLE IF NOT EXISTS calendar_oauth (
  provider TEXT PRIMARY KEY,
  access_token TEXT,
  refresh_token TEXT,
  token_type TEXT,
  scope TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
