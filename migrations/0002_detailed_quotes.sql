-- v2.1 : soumissions détaillées (lignes, TPS/TVQ), profil d'entreprise, lien client, acceptation en ligne

-- Profil d'entreprise (affiché sur la soumission envoyée au client)
ALTER TABLE users ADD COLUMN business_phone TEXT;
ALTER TABLE users ADD COLUMN business_email TEXT;
ALTER TABLE users ADD COLUMN business_address TEXT;
ALTER TABLE users ADD COLUMN rbq_number TEXT;
ALTER TABLE users ADD COLUMN gst_number TEXT;
ALTER TABLE users ADD COLUMN qst_number TEXT;
ALTER TABLE users ADD COLUMN charge_taxes INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN default_terms TEXT;
ALTER TABLE users ADD COLUMN next_quote_number INTEGER NOT NULL DEFAULT 1;

-- Détail de la soumission (items_json NULL = montant simple, comme avant)
ALTER TABLE quotes ADD COLUMN number TEXT;
ALTER TABLE quotes ADD COLUMN items_json TEXT;
ALTER TABLE quotes ADD COLUMN subtotal_cents INTEGER;
ALTER TABLE quotes ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quotes ADD COLUMN taxes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quotes ADD COLUMN gst_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quotes ADD COLUMN qst_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quotes ADD COLUMN valid_until TEXT;
ALTER TABLE quotes ADD COLUMN terms TEXT;
ALTER TABLE quotes ADD COLUMN client_address TEXT;

-- Lien client : consultation, ouvertures, décision en ligne
ALTER TABLE quotes ADD COLUMN share_token TEXT;
ALTER TABLE quotes ADD COLUMN shared_at INTEGER;
ALTER TABLE quotes ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quotes ADD COLUMN first_viewed_at INTEGER;
ALTER TABLE quotes ADD COLUMN last_viewed_at INTEGER;
ALTER TABLE quotes ADD COLUMN decided_online_at INTEGER;
ALTER TABLE quotes ADD COLUMN decided_by_name TEXT;
ALTER TABLE quotes ADD COLUMN client_message TEXT;
ALTER TABLE quotes ADD COLUMN accepted_snapshot TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_share ON quotes(share_token);
