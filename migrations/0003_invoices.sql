-- v2.2 : factures (créées à partir d'une soumission), paiements, lien client

ALTER TABLE users ADD COLUMN next_invoice_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN payment_instructions TEXT;
ALTER TABLE users ADD COLUMN invoice_due_days INTEGER NOT NULL DEFAULT 30;

CREATE TABLE IF NOT EXISTS invoices (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- La facture survit à la suppression de la soumission (pièce comptable).
  quote_id          TEXT REFERENCES quotes(id) ON DELETE SET NULL,
  number            TEXT NOT NULL,
  client            TEXT NOT NULL,
  project           TEXT NOT NULL,
  client_email      TEXT,
  client_phone      TEXT,
  client_address    TEXT,
  items_json        TEXT NOT NULL,
  subtotal_cents    INTEGER NOT NULL,
  discount_cents    INTEGER NOT NULL DEFAULT 0,
  taxes             INTEGER NOT NULL DEFAULT 0,
  gst_cents         INTEGER NOT NULL DEFAULT 0,
  qst_cents         INTEGER NOT NULL DEFAULT 0,
  total_cents       INTEGER NOT NULL CHECK (total_cents >= 0),
  issued_on         TEXT NOT NULL,
  due_on            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','paid','void')),
  paid_on           TEXT,
  payment_method    TEXT,
  terms             TEXT,
  notes             TEXT,
  reminder_count    INTEGER NOT NULL DEFAULT 0,
  last_reminder_on  TEXT,
  share_token       TEXT,
  shared_at         INTEGER,
  view_count        INTEGER NOT NULL DEFAULT 0,
  first_viewed_at   INTEGER,
  last_viewed_at    INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_share ON invoices(share_token);
-- Une seule facture par soumission.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_quote ON invoices(quote_id) WHERE quote_id IS NOT NULL;
