# Soumission Pro — contexte pour les sessions de code

SaaS québécois pour entrepreneurs en construction : soumissions détaillées (TPS/TVQ), lien client avec acceptation
en ligne, relances, factures. Propriétaire : Jay (Montréal). Interface en français québécois.

## Production
- Worker Cloudflare `soumission-pro-quebec-claude` → https://soumission-pro-quebec-claude.jsnoel6969.workers.dev
- Déploiement automatique à chaque push sur `main` (intégration GitHub de Cloudflare, commande `npx wrangler deploy`).
- Base D1 `soumission-pro` (id dans `wrangler.toml`). Les migrations s'appliquent À LA MAIN avant de pousser le code
  qui en dépend : `npx wrangler d1 migrations apply soumission-pro --remote`. 0001 à 0003 sont déjà appliquées et
  inscrites dans `d1_migrations`. 0004 (v2.6) aussi. Une migration doit être additive (ADD COLUMN, CREATE) : le code en ligne doit
  continuer de fonctionner pendant la fenêtre entre migration et déploiement.
- Secrets dans le tableau de bord (jamais dans le dépôt) : ADMIN_TOKEN, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY.
- Ne pas toucher aux Workers `soumission-pro-quebec` (ancienne prod) ni `soumission-pro-quebec-staging`.

## Architecture
- `src/` Worker (JS modules, aucune dépendance) : `index.js` routeur ; `routes/` auth, quotes, public (lien /s/),
  invoices (factures + lien /f/), billing (Stripe), admin (KPI) ; `lib/` http, crypto (PBKDF2), session, guards
  (droits d'accès, limites de débit, événements), validate (toute validation serveur), stripe, mail.
- `public/` site statique servi par Workers Assets, sans étape de build : `index.html` (landing), `app.html` +
  `assets/app.js` (application), `assets/invoices-ui.js`, `assets/line-editor.js`, `soumission.html` +
  `assets/quote-page.js` (page client des soumissions et factures).
- `public/assets/money.js` est importé PAR LE NAVIGATEUR ET PAR LE SERVEUR : un seul calcul de taxes.
  Montants en cents entiers, quantités en millièmes. TPS 5 % et TVQ 9,975 % sur le montant après rabais.
- `legacy/` : code du staging du 25 oct. (référence seulement, jamais déployé).
- `public/sw.js` : service worker (app hors ligne). **Changer `VERSION` à chaque mise en production** et tenir
  `SHELL_FILES` à jour quand un fichier de `public/assets` est ajouté ou renommé (sinon l'installation échoue).
- `assets/offline.js` : boîte d'envoi hors ligne (création, modification, signature), liée au compte (`userId`).
- `assets/catalog-ui.js` (bibliothèque), `assets/sign-ui.js` + `assets/signature-pad.js` (faire signer ici),
  `assets/dossier-page.js` (dossier Bouclier Paiement, page `/dossier`).

## Règles
- Chaque route d'écriture : `requireUser` + `assertCanWrite` + filtre `user_id` dans le SQL (isolation des comptes).
- Validation côté serveur dans `lib/validate.js`, miroir côté client dans `utils.js` (messages identiques).
- Jamais d'`innerHTML` avec des données utilisateur : utiliser `h()` de `utils.js`.
- Les pages client (`/s/`, `/f/`) n'exposent jamais les notes privées, les coordonnées du client, ni les coûts
  (`costCents`, `itemId` restent dans items_json ; `itemsToJson(items)` sans `{ owner: true }` les retire).
- Bouclier Paiement et signature à domicile : rappels de dates, jamais un avis juridique. Aucun texte de « mentions
  obligatoires » n'est ajouté au contrat tant qu'un avocat ne l'a pas validé.
- L'app n'envoie rien aux clients : elle prépare les messages, l'entrepreneur les envoie (promesse produit + LCAP).
- Ton : tutoiement dans l'app (l'entrepreneur), vouvoiement sur les pages client (le client de l'entrepreneur).
- Pas de nouvelle dépendance npm ni d'étape de build sans raison forte : le déploiement se fait depuis un cellulaire.

## Tests (obligatoires avant chaque push)
```
STRIPE_MOCK=1 node scripts/local-server.mjs 8787 &   # Node 22+, SQLite intégré, aucune install
BILLING=off node scripts/local-server.mjs 8788 &
node scripts/e2e.mjs http://localhost:8787            # 196 vérifications
node scripts/e2e.mjs http://localhost:8788 --billing-off   # 182 vérifications
```
Redémarrer les serveurs entre deux passes (limite de 10 inscriptions par heure et par IP).

## Feuille de route (mise à jour le 1er nov. 2026, plan « domination »)
1. ✔ v2.3 : lignes optionnelles.
2. ✔ v2.6 : bibliothèque + forfaits + marge privée, Dupliquer, écran Aujourd'hui et barre du bas, signature au doigt
   (sur place et en ligne), facture d'acompte automatique, Bouclier Paiement (hypothèque légale), hors ligne.
3. Contrat Québec : mentions obligatoires de la vente à domicile, APRÈS validation par un avocat (textes fournis par lui).
4. 3 niveaux Bon / Meilleur / Excellent sur la page client.
5. Demande d'avis Google quand une facture passe à « payée ».
6. Après 10 payants : acompte par carte (Stripe Connect), dictée de soumission par IA (à partir de la bibliothèque).
Refusés pour l'instant : envoi automatique de SMS ou de courriels aux clients, suivi du temps passé par section
(profilage, Loi 25), changement de pile vers Next.js/Postgres, planification d'équipe, portail client avant 50 payants.
