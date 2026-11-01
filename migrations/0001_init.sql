-- Soumission Pro — schéma initial (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS users (
  id                     TEXT PRIMARY KEY,
  email                  TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash          TEXT NOT NULL,
  display_name           TEXT,
  company                TEXT,
  created_at             INTEGER NOT NULL,
  last_seen_at           INTEGER,
  trial_ends_at          INTEGER NOT NULL,
  plan_status            TEXT NOT NULL DEFAULT 'trial'
                         CHECK (plan_status IN ('trial','active','past_due','canceled')),
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  billing_interest_at    INTEGER,
  terms_accepted_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_sub ON users(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_users_customer ON users(stripe_customer_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS quotes (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client            TEXT NOT NULL,
  project           TEXT NOT NULL,
  amount_cents      INTEGER NOT NULL CHECK (amount_cents >= 0),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','accepted','refused')),
  sent_on           TEXT NOT NULL,          -- AAAA-MM-JJ
  follow_up_on      TEXT,                   -- AAAA-MM-JJ
  client_email      TEXT,
  client_phone      TEXT,
  notes             TEXT,
  follow_up_count   INTEGER NOT NULL DEFAULT 0,
  last_follow_up_on TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quotes_user ON quotes(user_id, updated_at);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

-- Entonnoir produit (signup → première soumission → checkout → abonné)
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_name ON events(name, created_at);

-- Idempotence des webhooks Stripe
CREATE TABLE IF NOT EXISTS stripe_events (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL
);
