-- v2.4 à v2.6 : bibliothèque d'articles et forfaits, coûts privés, signature sur place,
-- facture d'acompte, Bouclier Paiement (fin des travaux), sous-traitance.
-- Migration additive : le code v2.3 en ligne continue de fonctionner tel quel.

-- Bibliothèque : articles (prix, coût privé) et forfaits (groupes de lignes)
CREATE TABLE IF NOT EXISTS catalog (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL DEFAULT 'item',   -- 'item' | 'package'
  name              TEXT NOT NULL,
  category          TEXT,
  unit              TEXT,
  price_cents       INTEGER,                        -- article : prix de vente
  cost_cents        INTEGER,                        -- article : coût, jamais montré au client
  lines_json        TEXT,                           -- forfait : lignes
  use_count         INTEGER NOT NULL DEFAULT 0,
  last_used_at      INTEGER,
  price_updated_at  INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_catalog_user ON catalog(user_id, use_count);

-- Profil : plancher de marge (alerte) et acompte automatique à la signature
ALTER TABLE users ADD COLUMN margin_floor_pct INTEGER;
ALTER TABLE users ADD COLUMN deposit_pct INTEGER NOT NULL DEFAULT 0;

-- Soumission : signature au doigt, signée sur place, signée au domicile du client, sous-traitance
ALTER TABLE quotes ADD COLUMN signature_png TEXT;
ALTER TABLE quotes ADD COLUMN signed_in_person INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quotes ADD COLUMN signed_at_home INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quotes ADD COLUMN subcontract INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quotes ADD COLUMN denounced_on TEXT;

-- Factures : acompte (une par soumission), acompte déduit avant taxes, fin des travaux
ALTER TABLE invoices ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard';  -- 'standard' | 'deposit'
ALTER TABLE invoices ADD COLUMN deposit_quote_id TEXT;
ALTER TABLE invoices ADD COLUMN deposit_applied_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN deposit_ref TEXT;
ALTER TABLE invoices ADD COLUMN work_end_on TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_deposit ON invoices(deposit_quote_id) WHERE deposit_quote_id IS NOT NULL;
