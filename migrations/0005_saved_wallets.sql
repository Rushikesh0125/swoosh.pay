CREATE TABLE IF NOT EXISTS saved_wallets (
  sender TEXT NOT NULL,
  merchant TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (sender, merchant)
) STRICT;
