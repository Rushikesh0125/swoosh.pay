CREATE TABLE IF NOT EXISTS commissions (
  id TEXT PRIMARY KEY,
  source_id TEXT UNIQUE NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  handle TEXT NOT NULL,
  quote TEXT NOT NULL,
  discord_token TEXT,
  created INTEGER NOT NULL,
  analysis TEXT,
  payment_id TEXT
) STRICT;

ALTER TABLE payments ADD COLUMN memo TEXT;
