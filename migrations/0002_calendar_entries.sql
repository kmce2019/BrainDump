CREATE TABLE IF NOT EXISTS calendar_entries (
  id TEXT PRIMARY KEY,
  capture_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT,
  timezone TEXT DEFAULT 'America/Chicago',
  all_day INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'exported', 'created', 'canceled', 'failed')),
  source TEXT DEFAULT 'telegram',
  external_calendar_id TEXT,
  external_event_id TEXT,
  ics_uid TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_calendar_entries_capture_id ON calendar_entries(capture_id);
CREATE INDEX IF NOT EXISTS idx_calendar_entries_status ON calendar_entries(status);
CREATE INDEX IF NOT EXISTS idx_calendar_entries_start_time ON calendar_entries(start_time);
