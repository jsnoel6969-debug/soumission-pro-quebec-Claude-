# Soumission Pro v2.6

Du prototype local (données dans un seul navigateur, aucun paiement) à un SaaS qui encaisse :
comptes, synchronisation cellulaire/ordinateur, essai gratuit, abonnement Stripe, export, suppression de compte, tableau de bord KPI.

**v2.6 (1er nov. 2026) — terrain et protection du paiement** (migration `0004_terrain.sql`)
- **Écran Aujourd'hui** et barre d'onglets en bas (Aujourd'hui · Soumissions · Factures · Profil) : relances, clients chauds,
  acomptes à encaisser, factures en retard, paiements à protéger, une action par carte.
- **Bibliothèque** : articles (prix de vente + coût privé) et forfaits, choisis en un toucher ; « Enregistrer comme forfait » ;
  ajustement en masse par catégorie (« Bois +8 % », prix et coût ensemble). Bouton **Dupliquer**. Nouvelle soumission détaillée d'office.
- **Marge privée** en direct dans l'éditeur (coût par ligne, plancher de marge du profil). Jamais envoyée au client (test e2e).
- **Faire signer ici** : le client choisit ses options et signe au doigt sur le téléphone de l'entrepreneur (`POST /api/quotes/:id/sign`).
  Signature facultative aussi sur le lien client. Signée au domicile : rappel du délai d'annulation possible de 10 jours.
- **Facture d'acompte** automatique à l'acceptation (pourcentage du profil) ; la facture finale déduit l'acompte avant taxes.
- **Bouclier Paiement** : date de fin des travaux sur la facture → délais de l'hypothèque légale (30 jours, 6 mois),
  alerte dans Aujourd'hui, dossier imprimable `/dossier?f=<id>`. Sous-traitance : rappel de dénoncer le contrat.
- **Hors ligne** : service worker (`public/sw.js`) qui garde l'app et les dernières données ; nouvelles soumissions,
  modifications et signatures sans réseau attendent dans une boîte d'envoi et partent au retour du réseau.

**v2.3 (1er nov. 2026) — options (upsell)**
- Une ligne peut être marquée « Option » : elle n'entre pas dans le prix de base. Sur sa page, le client coche les options
  voulues ; le total et les taxes se recalculent en direct (même money.js que le serveur). L'acceptation fige les options
  retenues et le montant ; la facture ne reprend que les options retenues.
- Correctif : les messages de confirmation s'affichent par-dessus les fenêtres ouvertes.

**v2.2 (1er nov. 2026) — factures**
- Une soumission (acceptée ou en attente) devient une facture en un geste : lignes, rabais, TPS/TVQ et client repris
  (la version acceptée en ligne si elle existe). Numérotation `F-2026-001`, une seule facture par soumission.
- Extras ajoutés sur la facture, échéance (délai par défaut dans le profil), modalités de paiement (ex. Interac).
- Lien client `/f/<jeton>` : facture imprimable/PDF, « Comment payer », ouvertures suivies.
- Paiement marqué à la main (Interac, chèque, comptant, carte), annulation sans réutiliser le numéro, rappels de paiement.
- Onglet Factures : à encaisser, en retard, encaissé sur 30 jours. Export CSV comptable pour ton CPA.
- Migration 0003 (déjà appliquée sur D1). `CLAUDE.md` décrit le projet pour les prochaines sessions de code.

**v2.1 (31 oct. 2026) — de la soumission au contrat accepté**
- Soumission détaillée : lignes (quantités décimales, unités), rabais, TPS 5 % et TVQ 9,975 % calculées au cent près
  (même fichier `public/assets/money.js` côté navigateur et serveur), numéro séquentiel `2026-001`.
- Profil d'entreprise : téléphone, courriel, adresse, licence RBQ, n° TPS/TVQ, conditions par défaut.
- Lien client `/s/<jeton>` : ton client consulte, imprime ou enregistre en PDF, accepte (nom + case) ou refuse (raison) sans compte.
  Notes privées et coordonnées du client jamais exposées. Version acceptée figée. Page jamais indexée.
- Ouvertures suivies (une par visite de 30 min, jamais les tiennes) ; les soumissions ouvertes dans les 48 h passent en tête des relances.
- Bannière dans l'app quand un client accepte ou refuse ; les messages de relance incluent le lien.

Tout tourne sur ton Worker Cloudflare actuel. **Aucune dépendance npm à part `wrangler`, aucun build.**

```
soumission-pro/
├── wrangler.toml              config Worker + D1 + variables
├── migrations/                0001 schéma, 0002 soumissions détaillées et lien client (déjà appliquées sur D1)
├── src/
│   ├── index.js               routeur API + /s/<jeton>
│   ├── lib/                   http, crypto (PBKDF2), sessions, validation, Stripe, courriel
│   └── routes/                auth, quotes, public (lien client), billing (Stripe), admin (KPI)
├── public/                    site + app (HTML/CSS/JS modules, aucune étape de build)
│   ├── index.html             landing (essai gratuit, calculateur, offre fondateur, FAQ)
│   ├── app.html               application (aussi en mode démo : /app?demo=1)
│   ├── soumission.html        page que voit ton client (servie sur /s/<jeton>)
│   ├── connexion.html         inscription / connexion / mot de passe oublié
│   ├── reinitialiser.html     nouveau mot de passe
│   ├── confidentialite.html   gabarit Loi 25 (à faire valider)
│   ├── conditions.html        gabarit (à faire valider)
│   ├── _headers               en-têtes de sécurité (CSP, HSTS…)
│   └── assets/                styles.css, app.js, quote-page.js, money.js, store.js, templates.js, utils.js…
├── legacy/                  code du staging du 25 oct. récupéré (base du futur forfait Pro)
└── scripts/
    ├── local-server.mjs       serveur de test sans wrangler (Node 22 + SQLite)
    └── e2e.mjs                378 vérifications API (196 avec Stripe, 182 sans)
```

---

## 1. Mettre en ligne

Déjà fait le 31 oct. 2026 : base D1 `soumission-pro` créée (ENAM) et tables en place (`wrangler.toml` est à jour).
La v2 se déploie sur un **Worker séparé**, `soumission-pro-quebec-claude` → https://soumission-pro-quebec-claude.jsnoel6969.workers.dev.
`soumission-pro-quebec` (prod actuelle) et `soumission-pro-quebec-staging` ne sont **pas touchés**.

Dans `wrangler.toml`, remplis **avant** de déployer :

| Variable | Valeur |
|---|---|
| `SUPPORT_EMAIL` | courriel de support affiché sur le site |
| `LEGAL_NAME` | nom de la personne responsable des renseignements personnels (obligatoire, Loi 25) |
| `PRICE_MONTHLY_CENTS` | `2900` = 29 $ (doit égaler le prix Stripe) |

**Option A : depuis GitHub (aucune ligne de commande, faisable au cellulaire)**
1. Le code est dans le dépôt GitHub privé.
2. Cloudflare → Workers & Pages → Créer → **Importer un dépôt** → choisis le dépôt.
   Nom du projet : `soumission-pro-quebec-claude` (doit correspondre à `name` dans `wrangler.toml`). Commande de déploiement : `npx wrangler deploy`.
3. Après le 1er déploiement : Worker `soumission-pro-quebec-claude` → Paramètres → Variables et secrets → ajouter le **secret** `ADMIN_TOKEN` (48 caractères aléatoires).
4. Chaque modification poussée sur `main` se redéploie toute seule.

**Option B : depuis un ordinateur**
```bash
npm install
npx wrangler login
npx wrangler secret put ADMIN_TOKEN    # valeur : openssl rand -hex 24
npm run deploy
```

Les variables `[vars]` de `wrangler.toml` remplacent celles du tableau de bord à chaque déploiement : modifie-les dans le fichier.
Les **secrets** (ADMIN_TOKEN, clés Stripe) restent, eux, dans le tableau de bord.

Sans Stripe configuré, tout fonctionne déjà : inscription, essai, app synchronisée.
Le bouton d'abonnement enregistre alors une **réservation fondateur** (signal de demande réel, visible dans les KPI),
et personne n'est bloqué à la fin de l'essai tant que le paiement n'est pas ouvert.

## 2. Ouvrir les paiements (Stripe)

1. Stripe → Produits → **Soumission Pro – Accès fondateur**, prix récurrent **mensuel 29 CAD** → copie le `price_…` dans `STRIPE_PRICE_ID`.
2. `npx wrangler secret put STRIPE_SECRET_KEY` (commence avec la clé **test** `sk_test_…`).
3. Stripe → Développeurs → Webhooks → endpoint `https://soumission-pro-quebec-claude.jsnoel6969.workers.dev/api/stripe/webhook`
   avec les événements : `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`
   → `npx wrangler secret put STRIPE_WEBHOOK_SECRET` (le `whsec_…`).
4. Stripe → Paramètres → Facturation → **Portail client** : activer, permettre l'annulation **à la fin de la période**, la mise à jour de la carte et l'historique des factures. Enregistrer.
5. `npm run deploy`, puis paye avec la carte test `4242 4242 4242 4242`. Vérifie que le compte passe à « Abonné ».
6. Remplace par les clés **live** et refais l'étape 3 en mode live.

Taxes : `STRIPE_AUTOMATIC_TAX="false"` par défaut. Inscription TPS/TVQ et seuil de petit fournisseur : **à valider avec ton CPA** avant d'activer.

## 3. Piloter (KPI, support)

```bash
T=ton_jeton_admin; U=https://soumission-pro-quebec-claude.jsnoel6969.workers.dev
curl -H "Authorization: Bearer $T" $U/api/admin/metrics   # entonnoir : inscriptions → activés → réservations → payants, MRR
curl -H "Authorization: Bearer $T" $U/api/admin/users     # 200 derniers comptes : appelle les essais en cours
curl -X POST -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
     -d '{"email":"client@exemple.ca"}' $U/api/admin/reset-link   # lien de réinitialisation (24 h)
```
Sous Windows PowerShell, utilise `curl.exe` au lieu de `curl`.

Mot de passe oublié : sans service courriel, le client t'écrit et tu lui envoies le lien généré ci-dessus.
Pour l'automatiser plus tard : domaine vérifié chez Resend + `RESEND_API_KEY` et `MAIL_FROM`.

## 4. Tester localement (sans compte Cloudflare)

```bash
STRIPE_MOCK=1 node scripts/local-server.mjs 8787   # Node 22+
npm test                                           # dans un 2e terminal
```

## Ce qui reste hors code (propriétaire)

- **Loi 25** : nommer publiquement le responsable (`LEGAL_NAME`), faire valider les deux pages légales, et documenter l'évaluation des facteurs relatifs à la vie privée exigée avant de confier des renseignements personnels à des fournisseurs hors Québec (Cloudflare, Stripe).
- **Import des anciennes démos** : l'app détecte automatiquement les soumissions laissées dans le navigateur (nouvelle et ancienne démo). Le format exact de l'ancienne démo n'a pas pu être vérifié : teste une fois avec ton propre navigateur.
