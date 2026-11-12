CREATE TABLE IF NOT EXISTS discord_installations (
  user_id TEXT PRIMARY KEY,
  installed INTEGER NOT NULL CHECK(installed IN (0, 1)),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS payments_discord_sender ON payments(sender) WHERE source_id IS NOT NULL;
