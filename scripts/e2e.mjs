// Tests de bout en bout de l'API contre le serveur local (scripts/local-server.mjs).
// Usage : node scripts/e2e.mjs [baseUrl] [--billing-off]
import { createHmac } from 'node:crypto';

const BASE = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'http://localhost:8787';
const BILLING_OFF = process.argv.includes('--billing-off');
const ADMIN = 'test-admin-token-0123456789abcdef';
const WHSEC = 'whsec_test_secret';
let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) passed++;
  else failures.push(`${name}${detail !== undefined ? ` → ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body, { origin = BASE, headers = {} } = {}) {
    const h = { ...headers };
    if (origin) h.origin = origin;
    if (this.cookie) h.cookie = this.cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(BASE + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const set = res.headers.getSetCookie();
    for (const c of set) {
      const [pair] = c.split(';');
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
}

const sql = (s, ...args) => fetch(`${BASE}/__mock/sql`, { method: 'POST', body: JSON.stringify({ sql: s, args }) });
const mockSub = (sub) => fetch(`${BASE}/__mock/stripe-sub`, { method: 'POST', body: JSON.stringify(sub) });
async function webhook(event, { secret = WHSEC, t = Math.floor(Date.now() / 1000) } = {}) {
  const payload = JSON.stringify(event);
  const sig = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  const res = await fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${sig}`, 'content-type': 'application/json' }, body: payload });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const today = new Date().toISOString().slice(0, 10);
const uniq = Date.now().toString(36);

async function main() {
  const a = new Client();
  let r;

  // --- Statique & public ---
  r = await a.req('GET', '/api/health'); check('health', r.status === 200 && r.data.ok);
  r = await a.req('GET', '/api/public/config');
  check('config', r.status === 200 && r.data.trialDays === 14 && r.data.priceMonthly === 29, r.data);
  check('config seats', BILLING_OFF ? r.data.founderSeatsLeft === null : r.data.founderSeatsLeft === 10, r.data);
  for (const p of ['/', '/app', '/connexion', '/reinitialiser', '/confidentialite', '/conditions', '/assets/app.js', '/manifest.webmanifest']) {
    r = await a.req('GET', p); check(`static ${p}`, r.status === 200, r.status);
  }
  r = await a.req('GET', '/nimporte-quoi'); check('404 page', r.status === 404 && String(r.data).includes('introuvable'));
  r = await a.req('GET', '/api/nope'); check('api 404', r.status === 404 && r.data.error.code === 'not_found');
  r = await a.req('GET', '/api/auth/login'); check('api 405', r.status === 405, r.status);

  // --- Inscription ---
  const email = `jay+${uniq}@exemple.ca`;
  r = await a.req('POST', '/api/auth/signup', { email, password: 'motdepasse1', displayName: 'Jay' });
  check('signup sans conditions', r.status === 400 && r.data.error.field === 'acceptTerms', r.data);
  r = await a.req('POST', '/api/auth/signup', { email, password: 'court', displayName: 'Jay', acceptTerms: true });
  check('signup mdp court', r.status === 400 && r.data.error.field === 'password', r.data);
  r = await a.req('POST', '/api/auth/signup', { email: 'pas-un-courriel', password: 'motdepasse1', displayName: 'Jay', acceptTerms: true });
  check('signup courriel invalide', r.status === 400 && r.data.error.field === 'email', r.data);
  r = await a.req('POST', '/api/auth/signup', { email, password: 'motdepasse1', displayName: 'Jay', company: 'Rénos JS', acceptTerms: true }, { origin: 'https://evil.example' });
  check('CSRF origine étrangère', r.status === 403, r.status);
  r = await a.req('POST', '/api/auth/signup', { email, password: 'motdepasse1', displayName: 'Jay', company: 'Rénos JS', acceptTerms: true }, { origin: null });
  check('CSRF sans origine', r.status === 403, r.status);
  r = await a.req('POST', '/api/auth/signup', { email: email.toUpperCase(), password: 'motdepasse1', displayName: 'Jay', company: 'Rénos JS', acceptTerms: true });
  check('signup ok', r.status === 201 && r.data.user.email === email && r.data.entitlement.state === 'trial' && r.data.entitlement.trialDaysLeft === 14, r.data);
  check('cookie session', a.cookie.startsWith('sp_session='));
  r = await new Client().req('POST', '/api/auth/signup', { email, password: 'motdepasse1', displayName: 'X', acceptTerms: true });
  check('signup doublon', r.status === 409 && r.data.error.code === 'email_taken', r.data);

  r = await a.req('GET', '/api/me'); check('me', r.status === 200 && r.data.user.displayName === 'Jay' && r.data.user.company === 'Rénos JS', r.data);
  r = await new Client().req('GET', '/api/me'); check('me anonyme 401', r.status === 401);

  // --- Soumissions ---
  r = await a.req('POST', '/api/quotes', { client: 'Famille Tremblay', project: 'Cuisine', amount: 'abc', sentOn: today });
  check('montant invalide', r.status === 400 && r.data.error.field === 'amount', r.data);
  r = await a.req('POST', '/api/quotes', { client: 'Famille Tremblay', project: 'Cuisine', amount: '8 450,50', sentOn: '2026-02-30' });
  check('date invalide', r.status === 400 && r.data.error.field === 'sentOn', r.data);
  r = await a.req('POST', '/api/quotes', { client: '  ', project: 'Cuisine', amount: 10, sentOn: today });
  check('client requis', r.status === 400 && r.data.error.field === 'client', r.data);
  r = await a.req('POST', '/api/quotes', { client: 'Famille Tremblay', project: 'Cuisine', amount: '8 450,50', sentOn: today, followUpOn: today, clientEmail: 'Client@Exemple.ca', clientPhone: '514 555-0101', notes: 'Veut du quartz' });
  check('création', r.status === 201 && r.data.quote.amount === 8450.5 && r.data.quote.clientEmail === 'client@exemple.ca' && r.data.quote.status === 'pending', r.data);
  const q1 = r.data.quote;
  r = await a.req('POST', '/api/quotes', { client: 'M. Gagnon', project: 'Terrasse', amount: 5900, status: 'En attente', sentOn: today });
  check('création 2 (alias statut)', r.status === 201 && r.data.quote.status === 'pending' && r.data.quote.followUpOn === null, r.data);
  const q2 = r.data.quote;

  r = await a.req('GET', '/api/quotes'); check('liste', r.status === 200 && r.data.quotes.length === 2, r.data);

  r = await a.req('PUT', `/api/quotes/${q2.id}`, { ...q2, status: 'accepted', amount: 6100 });
  check('modification', r.status === 200 && r.data.quote.status === 'accepted' && r.data.quote.amount === 6100, r.data);

  r = await a.req('POST', `/api/quotes/${q1.id}/follow-up`, { doneOn: today, nextFollowUpOn: '2000-01-01' });
  check('relance date passée refusée', r.status === 400, r.data);
  const next = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  r = await a.req('POST', `/api/quotes/${q1.id}/follow-up`, { doneOn: today, nextFollowUpOn: next });
  check('relance faite', r.status === 200 && r.data.quote.followUpCount === 1 && r.data.quote.followUpOn === next && r.data.quote.lastFollowUpOn === today, r.data);
  r = await a.req('POST', `/api/quotes/${q1.id}/follow-up`, { doneOn: today, nextFollowUpOn: null });
  check('relance finale', r.status === 200 && r.data.quote.followUpCount === 2 && r.data.quote.followUpOn === null, r.data);

  // Isolation entre comptes
  const b = new Client();
  r = await b.req('POST', '/api/auth/signup', { email: `autre+${uniq}@exemple.ca`, password: 'motdepasse2', displayName: 'Autre', acceptTerms: true });
  check('signup B', r.status === 201, r.data);
  r = await b.req('GET', '/api/quotes'); check('B ne voit rien', r.data.quotes.length === 0, r.data);
  r = await b.req('PUT', `/api/quotes/${q1.id}`, { ...q1, client: 'Pirate' }); check('B ne modifie pas A', r.status === 404, r.data);
  r = await b.req('DELETE', `/api/quotes/${q1.id}`); check('B ne supprime pas A', r.status === 404, r.data);
  r = await b.req('POST', `/api/quotes/${q1.id}/follow-up`, { doneOn: today }); check('B ne relance pas A', r.status === 404, r.data);

  // Import tolérant
  r = await a.req('POST', '/api/quotes/import', { quotes: [
    { client: 'Import 1', project: 'Sous-sol', amount: 12000, sentOn: today, status: 'pending', followUpCount: 2, lastFollowUpOn: today },
    { client: '', project: 'Invalide', amount: 1, sentOn: today },
    { client: 'Import 3', project: 'Toiture', amount: '15 000', sentOn: today, status: 'refusée' },
  ] });
  check('import', r.status === 200 && r.data.imported === 2 && r.data.skipped === 1, r.data);
  r = await a.req('GET', '/api/quotes');
  const imp = r.data.quotes.find((q) => q.client === 'Import 1');
  check('import compteur conservé', imp && imp.followUpCount === 2 && imp.lastFollowUpOn === today, imp);
  check('import statut alias', r.data.quotes.some((q) => q.client === 'Import 3' && q.status === 'refused'));

  r = await a.req('DELETE', `/api/quotes/${q2.id}`); check('suppression', r.status === 200);
  r = await a.req('DELETE', `/api/quotes/${q2.id}`); check('suppression double 404', r.status === 404);

  // Profil
  r = await a.req('PATCH', '/api/me', { displayName: 'Jean-Sébastien', company: '' });
  check('profil', r.status === 200 && r.data.user.displayName === 'Jean-Sébastien' && r.data.user.company === '', r.data);

  // --- Soumission détaillée + lien client (v2.1) ---
  const plusDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  r = await a.req('PATCH', '/api/me', { displayName: 'Jean-Sébastien', company: 'Rénos JS', business: {
    businessPhone: '514 555-0199', businessEmail: 'Info@RenosJS.ca', businessAddress: '123 rue Principale, Montréal',
    rbqNumber: '5678-1234-01', gstNumber: '123456789RT0001', qstNumber: '1234567890TQ0001', chargeTaxes: true,
    defaultTerms: 'Paiement : 30 % à la signature.' } });
  check('profil entreprise', r.status === 200 && r.data.user.business.rbqNumber === '5678-1234-01'
    && r.data.user.business.businessEmail === 'info@renosjs.ca' && r.data.user.business.chargeTaxes === true, r.data);
  r = await a.req('PATCH', '/api/me', { displayName: 'Jean-Sébastien', company: 'Rénos JS', business: { businessEmail: 'pas-valide' } });
  check('profil courriel invalide', r.status === 400 && r.data.error.field === 'businessEmail', r.data);

  const detailed = {
    client: 'Marie Tremblay', project: 'Salle de bain complète', sentOn: today, followUpOn: plusDays(3),
    validUntil: plusDays(30), clientAddress: '45 av. des Pins, Laval', terms: 'Paiement : 30 % à la signature.',
    notes: 'NOTE PRIVÉE : client hésite sur la céramique', clientEmail: 'marie@exemple.ca',
    items: [
      { description: 'Main-d’œuvre', qty: '12,5', unit: 'h', unitPrice: '65' },
      { description: 'Matériaux et fournitures', qty: 1, unitPrice: '1 234,56' },
      { description: '', qty: '', unitPrice: '' },
    ],
    discount: '100', taxes: true,
  };
  r = await a.req('POST', '/api/quotes', { ...detailed, items: [{ description: 'X', qty: '0', unitPrice: '10' }] });
  check('ligne quantité invalide', r.status === 400 && r.data.error.field === 'items.0.qty', r.data);
  r = await a.req('POST', '/api/quotes', { ...detailed, discount: '99999' });
  check('rabais trop grand', r.status === 400 && r.data.error.field === 'discount', r.data);
  r = await a.req('POST', '/api/quotes', detailed);
  const dq = r.data.quote;
  check('soumission détaillée', r.status === 201 && dq.detailed && dq.items.length === 2 && dq.subtotal === 2047.06
    && dq.discount === 100 && dq.gst === 97.35 && dq.qst === 194.22 && dq.amount === 2238.63 && /^\d{4}-\d{3}$/.test(dq.number), dq);
  check('ligne décimale', dq.items[0].qty === 12.5 && dq.items[0].total === 812.5 && dq.items[0].unit === 'h', dq.items[0]);
  r = await a.req('POST', '/api/quotes', { client: 'Simple', project: 'Montant seul', amount: 500, sentOn: today });
  check('soumission simple', r.status === 201 && r.data.quote.detailed === false && r.data.quote.items.length === 0 && r.data.quote.amount === 500, r.data);
  const simpleId = r.data.quote.id;
  check('numéros séquentiels', Number(r.data.quote.number.slice(5)) === Number(dq.number.slice(5)) + 1, [dq.number, r.data.quote.number]);

  r = await a.req('POST', `/api/quotes/${dq.id}/share`, {});
  const tok = r.data.quote && r.data.quote.shareToken;
  check('lien créé', r.status === 200 && typeof tok === 'string' && tok.length >= 30, r.data);
  r = await a.req('POST', `/api/quotes/${dq.id}/share`, {});
  check('lien stable', r.data.quote.shareToken === tok, r.data);
  r = await b.req('POST', `/api/quotes/${dq.id}/share`, {});
  check('B ne partage pas A', r.status === 404, r.status);

  r = await a.req('GET', `/api/public/quotes/${tok}`);
  check('aperçu propriétaire', r.status === 200 && r.data.viewer.isOwner === true, r.data);
  const visitor = new Client();
  r = await visitor.req('GET', `/api/public/quotes/${tok}`);
  const pubText = JSON.stringify(r.data);
  check('page client', r.status === 200 && r.data.viewer.isOwner === false && r.data.quote.total === 2238.63
    && r.data.business.name === 'Rénos JS' && r.data.business.rbq === '5678-1234-01' && r.data.quote.items.length === 2, r.data);
  check('rien de privé côté client', !pubText.includes('NOTE PRIVÉE') && !pubText.includes('marie@exemple.ca') && !pubText.includes(email), pubText.slice(0, 300));
  await visitor.req('GET', `/api/public/quotes/${tok}`);
  r = await a.req('GET', '/api/quotes');
  let mine = r.data.quotes.find((q) => q.id === dq.id);
  check('ouverture comptée une fois', mine.viewCount === 1 && mine.lastViewedAt > 0, mine);

  r = await a.req('POST', `/api/public/quotes/${tok}/decision`, { decision: 'accept', name: 'Moi', confirm: true });
  check('propriétaire ne peut pas accepter', r.status === 403, r.data);
  r = await visitor.req('POST', `/api/public/quotes/${tok}/decision`, { decision: 'accept', name: 'Marie Tremblay' });
  check('acceptation sans case', r.status === 400 && r.data.error.field === 'confirm', r.data);
  r = await visitor.req('POST', `/api/public/quotes/${tok}/decision`, { decision: 'accept', confirm: true });
  check('acceptation sans nom', r.status === 400 && r.data.error.field === 'name', r.data);
  r = await visitor.req('POST', `/api/public/quotes/${tok}/decision`, { decision: 'accept', name: 'Marie Tremblay', confirm: true }, { origin: 'https://evil.example' });
  check('décision CSRF', r.status === 403, r.status);
  r = await visitor.req('POST', `/api/public/quotes/${tok}/decision`, { decision: 'accept', name: 'Marie Tremblay', confirm: true });
  check('acceptée en ligne', r.status === 200 && r.data.quote.status === 'accepted' && r.data.quote.decidedByName === 'Marie Tremblay', r.data);
  r = await visitor.req('POST', `/api/public/quotes/${tok}/decision`, { decision: 'refuse' });
  check('double décision', r.status === 409, r.data);
  r = await a.req('GET', '/api/quotes');
  mine = r.data.quotes.find((q) => q.id === dq.id);
  check('vue propriétaire', mine.status === 'accepted' && mine.decidedOnlineAt > 0 && mine.followUpOn === null && mine.decidedByName === 'Marie Tremblay', mine);

  r = await a.req('PUT', `/api/quotes/${dq.id}`, { ...mine, items: [{ description: 'Autre chose', qty: 1, unitPrice: 1 }], taxes: false });
  r = await visitor.req('GET', `/api/public/quotes/${tok}`);
  check('version acceptée figée', r.data.quote.total === 2238.63 && r.data.quote.items.length === 2, r.data.quote);
  r = await a.req('PUT', `/api/quotes/${dq.id}`, { ...detailed, status: 'pending' });
  check('remise en attente efface la décision', r.status === 200 && r.data.quote.decidedOnlineAt === null && r.data.quote.decidedByName === '', r.data);
  r = await visitor.req('POST', `/api/public/quotes/${tok}/decision`, { decision: 'refuse', message: 'Budget trop élevé pour cette année.' });
  check('refusée en ligne', r.status === 200 && r.data.quote.status === 'refused', r.data);
  r = await a.req('GET', '/api/quotes');
  mine = r.data.quotes.find((q) => q.id === dq.id);
  check('raison du refus', mine.clientMessage === 'Budget trop élevé pour cette année.', mine);

  r = await a.req('DELETE', `/api/quotes/${dq.id}/share`);
  check('lien désactivé', r.status === 200 && r.data.quote.shareToken === null, r.data);
  r = await visitor.req('GET', `/api/public/quotes/${tok}`);
  check('ancien lien mort', r.status === 404, r.status);

  const yesterday = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
  r = await a.req('POST', '/api/quotes', { client: 'Vieux', project: 'Expirée', amount: 100, sentOn: yesterday, validUntil: yesterday });
  r = await a.req('POST', `/api/quotes/${r.data.quote.id}/share`, {});
  const tokOld = r.data.quote.shareToken;
  r = await visitor.req('GET', `/api/public/quotes/${tokOld}`);
  check('expirée affichée', r.data.quote.expired === true, r.data.quote);
  r = await visitor.req('POST', `/api/public/quotes/${tokOld}/decision`, { decision: 'accept', name: 'Vieux', confirm: true });
  check('expirée non acceptable', r.status === 409 && r.data.error.code === 'expired', r.data);

  r = await a.req('POST', `/api/quotes/${simpleId}/share`, {});
  const page = await fetch(`${BASE}/s/${r.data.quote.shareToken}`);
  const html = await page.text();
  check('page /s/ servie', page.status === 200 && html.includes('quote-page.js') && page.headers.get('x-robots-tag') === 'noindex, nofollow'
    && page.headers.get('referrer-policy') === 'no-referrer', page.status);
  r = await visitor.req('GET', '/api/public/quotes/inexistantinexistantinexistant');
  check('jeton inconnu', r.status === 404, r.status);

  // --- Factures (v2.2) ---
  r = await a.req('PATCH', '/api/me', { displayName: 'Jean-Sébastien', company: 'Rénos JS', business: {
    businessPhone: '514 555-0199', rbqNumber: '5678-1234-01', gstNumber: '123456789RT0001', qstNumber: '1234567890TQ0001',
    paymentInstructions: 'Virement Interac à paiement@renosjs.ca', invoiceDueDays: 15 } });
  check('profil paiement', r.status === 200 && r.data.user.business.paymentInstructions.startsWith('Virement') && r.data.user.business.invoiceDueDays === 15, r.data);
  r = await a.req('PATCH', '/api/me', { displayName: 'Jean-Sébastien', business: { invoiceDueDays: 500 } });
  check('délai invalide', r.status === 400 && r.data.error.field === 'invoiceDueDays', r.data);
  await a.req('PATCH', '/api/me', { displayName: 'Jean-Sébastien', company: 'Rénos JS', business: {
    businessPhone: '514 555-0199', rbqNumber: '5678-1234-01', gstNumber: '123456789RT0001', qstNumber: '1234567890TQ0001',
    paymentInstructions: 'Virement Interac à paiement@renosjs.ca', invoiceDueDays: 30 } });

  r = await a.req('POST', '/api/quotes', { client: 'Luc Bérubé', project: 'Salle de bain', sentOn: today, clientEmail: 'luc@exemple.ca',
    notes: 'NOTE PRIVÉE FACTURE', items: [{ description: 'Main-d’œuvre', qty: 10, unit: 'h', unitPrice: 75 }, { description: 'Matériaux', qty: 1, unitPrice: 500 }],
    discount: 50, taxes: true });
  const q3 = r.data.quote;
  r = await a.req('POST', `/api/quotes/${q3.id}/share`, {});
  const t3 = r.data.quote.shareToken;
  r = await visitor.req('POST', `/api/public/quotes/${t3}/decision`, { decision: 'accept', name: 'Luc Bérubé', confirm: true });
  check('q3 acceptée', r.status === 200, r.data);
  // Changement après acceptation : la facture doit reprendre la version acceptée.
  await a.req('PUT', `/api/quotes/${q3.id}`, { ...q3, status: 'accepted', items: [{ description: 'Autre', qty: 1, unitPrice: 1 }] });

  r = await a.req('POST', `/api/quotes/${q3.id}/invoice`, {});
  const inv = r.data.invoice;
  check('facture créée', r.status === 201 && r.data.created === true && /^F-\d{4}-001$/.test(inv.number) && inv.total === 1379.7
    && inv.items.length === 2 && inv.taxes === true && inv.gst === 60 && inv.qst === 119.7 && inv.status === 'unpaid' && inv.quoteId === q3.id, r.data);
  const plus30 = new Date(Date.parse(inv.issuedOn + 'T12:00:00Z') + 30 * 864e5).toISOString().slice(0, 10);
  check('échéance 30 jours', inv.dueOn === plus30, [inv.issuedOn, inv.dueOn]);
  r = await a.req('POST', `/api/quotes/${q3.id}/invoice`, {});
  check('une seule facture par soumission', r.status === 200 && r.data.created === false && r.data.invoice.id === inv.id, r.data);
  r = await a.req('POST', `/api/quotes/${simpleId}/invoice`, {});
  const inv2 = r.data.invoice;
  check('facture depuis montant simple', r.status === 201 && inv2.items.length === 1 && inv2.total === 500 && inv2.taxes === false && /^F-\d{4}-002$/.test(inv2.number), r.data);
  r = await a.req('POST', `/api/quotes/${dq.id}/invoice`, {});
  check('pas de facture sur refusée', r.status === 409, r.data);

  r = await b.req('GET', '/api/invoices');
  check('B ne voit pas les factures de A', r.status === 200 && r.data.invoices.length === 0, r.data);
  r = await b.req('PUT', `/api/invoices/${inv.id}`, inv);
  check('B ne modifie pas la facture de A', r.status === 404, r.status);
  r = await b.req('POST', `/api/invoices/${inv.id}/payment`, { paidOn: today, method: 'interac' });
  check('B ne paie pas la facture de A', r.status === 404, r.status);

  r = await a.req('PUT', `/api/invoices/${inv.id}`, { ...inv, dueOn: '2000-01-01' });
  check('échéance avant facture refusée', r.status === 400 && r.data.error.field === 'dueOn', r.data);
  r = await a.req('PUT', `/api/invoices/${inv.id}`, { ...inv, items: [] });
  check('facture sans ligne refusée', r.status === 400 && r.data.error.field === 'items.0.description', r.data);
  r = await a.req('PUT', `/api/invoices/${inv.id}`, { ...inv, items: [...inv.items, { description: 'Extra : prise GFCI', qty: 1, unitPrice: 120 }] });
  check('extra ajouté', r.status === 200 && r.data.invoice.subtotal === 1370 && r.data.invoice.total === 1517.67, r.data.invoice);

  r = await a.req('POST', `/api/invoices/${inv.id}/payment`, { method: 'interac' });
  check('paiement sans date', r.status === 400 && r.data.error.field === 'paidOn', r.data);
  r = await a.req('POST', `/api/invoices/${inv.id}/payment`, { paidOn: today, method: 'bitcoin' });
  check('mode de paiement invalide', r.status === 400 && r.data.error.field === 'method', r.data);
  r = await a.req('POST', `/api/invoices/${inv.id}/payment`, { paidOn: today, method: 'interac' });
  check('payée', r.status === 200 && r.data.invoice.status === 'paid' && r.data.invoice.paidOn === today && r.data.invoice.paymentMethod === 'interac', r.data);
  r = await a.req('PUT', `/api/invoices/${inv.id}`, inv);
  check('facture payée verrouillée', r.status === 409, r.data);
  r = await a.req('POST', `/api/invoices/${inv.id}/void`, {});
  check('pas d’annulation si payée', r.status === 409, r.data);
  r = await a.req('DELETE', `/api/invoices/${inv.id}/payment`);
  check('paiement annulé', r.status === 200 && r.data.invoice.status === 'unpaid' && r.data.invoice.paidOn === null, r.data);
  r = await a.req('POST', `/api/invoices/${inv2.id}/reminder`, {});
  check('relance de paiement', r.status === 200 && r.data.invoice.reminderCount === 1 && r.data.invoice.lastReminderOn, r.data);
  r = await a.req('POST', `/api/invoices/${inv2.id}/void`, {});
  check('facture annulée', r.status === 200 && r.data.invoice.status === 'void', r.data);
  r = await a.req('PUT', `/api/invoices/${inv2.id}`, inv2);
  check('annulée verrouillée', r.status === 409, r.data);
  r = await a.req('POST', `/api/invoices/${inv2.id}/reminder`, {});
  check('pas de relance si annulée', r.status === 409, r.data);

  r = await a.req('POST', `/api/invoices/${inv.id}/share`, {});
  const ftok = r.data.invoice.shareToken;
  check('lien facture', r.status === 200 && typeof ftok === 'string' && ftok.length >= 30, r.data);
  r = await visitor.req('GET', `/api/public/invoices/${ftok}`);
  const ftext = JSON.stringify(r.data);
  check('page facture client', r.status === 200 && r.data.invoice.total === 1517.67 && r.data.invoice.status === 'unpaid'
    && r.data.business.paymentInstructions.startsWith('Virement') && r.data.viewer.isOwner === false, r.data);
  check('facture : rien de privé', !ftext.includes('NOTE PRIVÉE') && !ftext.includes('luc@exemple.ca'), ftext.slice(0, 200));
  r = await a.req('GET', '/api/invoices');
  check('ouverture de facture comptée', r.data.invoices.find((x) => x.id === inv.id).viewCount === 1, r.data);
  const fpage = await fetch(`${BASE}/f/${ftok}`);
  check('page /f/ servie', fpage.status === 200 && (await fpage.text()).includes('quote-page.js'), fpage.status);
  r = await a.req('DELETE', `/api/invoices/${inv.id}/share`);
  r = await visitor.req('GET', `/api/public/invoices/${ftok}`);
  check('lien facture désactivé', r.status === 404, r.status);

  // --- Connexion ---
  r = await a.req('POST', '/api/auth/logout', {}); check('logout', r.status === 200 && a.cookie === '');
  r = await a.req('GET', '/api/me'); check('après logout 401', r.status === 401);
  r = await a.req('POST', '/api/auth/login', { email, password: 'mauvais-mdp' }); check('login mauvais mdp', r.status === 401, r.data);
  r = await a.req('POST', '/api/auth/login', { email: `inconnu+${uniq}@exemple.ca`, password: 'peu-importe' }); check('login inconnu', r.status === 401, r.data);
  r = await a.req('POST', '/api/auth/login', { email: email.toUpperCase(), password: 'motdepasse1' }); check('login ok', r.status === 200 && a.cookie, r.data);

  // --- Fin d'essai ---
  await sql('UPDATE users SET trial_ends_at = ? WHERE email = ?', Date.now() - 1000, email);
  r = await a.req('GET', '/api/me');
  if (BILLING_OFF) {
    check('essai fini sans facturation = accès prolongé', r.data.entitlement.canWrite === true && r.data.entitlement.grace === true, r.data);
    r = await a.req('POST', '/api/quotes', { client: 'Grace', project: 'Test', amount: 1, sentOn: today });
    check('écriture en accès prolongé', r.status === 201, r.data);
    r = await a.req('POST', '/api/billing/checkout', {});
    check('intérêt enregistré', r.status === 200 && r.data.interestRecorded === true, r.data);
    r = await a.req('GET', '/api/me'); check('intérêt visible', r.data.user.billingInterest === true, r.data);
  } else {
    check('essai fini = lecture seule', r.data.entitlement.state === 'trial_expired' && r.data.entitlement.canWrite === false, r.data);
    r = await a.req('POST', '/api/quotes', { client: 'X', project: 'Y', amount: 1, sentOn: today });
    check('écriture bloquée 402', r.status === 402 && r.data.error.code === 'subscription_required', r.data);
    r = await a.req('GET', '/api/quotes'); check('lecture toujours ok', r.status === 200 && r.data.quotes.length >= 3, r.data.quotes && r.data.quotes.length);

    // --- Paiement ---
    r = await a.req('POST', '/api/billing/portal', {}); check('portail sans client', r.status === 400, r.data);
    r = await a.req('POST', '/api/billing/checkout', {});
    check('checkout url', r.status === 200 && r.data.url.startsWith('https://checkout.stripe.com/'), r.data);
    const sent = await (await fetch(`${BASE}/__mock/last-checkout`)).json();
    const me = (await a.req('GET', '/api/me')).data.user;
    check('checkout params', sent.mode === 'subscription' && sent.client_reference_id === me.id && sent.customer_email === email
      && sent['line_items[0][price]'] === 'price_mock' && sent.locale === 'fr-CA' && sent['subscription_data[metadata][user_id]'] === me.id, sent);

    let w = await webhook({ id: 'evt_bad', type: 'checkout.session.completed', data: { object: {} } }, { secret: 'whsec_mauvais' });
    check('webhook signature invalide', w.status === 400, w);
    w = await webhook({ id: 'evt_old', type: 'ping', data: { object: {} } }, { t: Math.floor(Date.now() / 1000) - 3600 });
    check('webhook trop vieux', w.status === 400, w);

    await mockSub({ id: 'sub_1', status: 'active', customer: 'cus_1', metadata: { user_id: me.id } });
    const evt = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', client_reference_id: me.id } } };
    w = await webhook(evt); check('webhook checkout', w.status === 200 && w.data.received, w);
    r = await a.req('GET', '/api/me');
    check('abonnement actif', r.data.entitlement.state === 'active' && r.data.user.hasBilling === true, r.data);
    w = await webhook(evt); check('webhook idempotent', w.status === 200 && w.data.duplicate === true, w);
    r = await a.req('POST', '/api/quotes', { client: 'Abonné', project: 'Ok', amount: 100, sentOn: today });
    check('écriture rétablie', r.status === 201, r.data);
    r = await a.req('POST', '/api/billing/checkout', {}); check('checkout déjà actif', r.status === 409, r.data);
    r = await a.req('POST', '/api/billing/portal', {}); check('portail', r.status === 200 && r.data.url.includes('billing.stripe.com'), r.data);
    r = await a.req('GET', '/api/public/config'); check('places restantes', r.data.founderSeatsLeft === 9, r.data);

    await mockSub({ id: 'sub_1', status: 'past_due', customer: 'cus_1', metadata: { user_id: me.id } });
    w = await webhook({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: { id: 'sub_1' } } });
    r = await a.req('GET', '/api/me'); check('paiement en échec', w.status === 200 && r.data.entitlement.state === 'past_due' && r.data.entitlement.canWrite, r.data);

    // Un vieil abonnement annulé ne doit pas écraser l'actif
    await mockSub({ id: 'sub_old', status: 'canceled', customer: 'cus_1', metadata: { user_id: me.id } });
    w = await webhook({ id: 'evt_3', type: 'customer.subscription.deleted', data: { object: { id: 'sub_old' } } });
    r = await a.req('GET', '/api/me'); check('vieil abonnement ignoré', r.data.entitlement.state === 'past_due', r.data);

    await mockSub({ id: 'sub_1', status: 'canceled', customer: 'cus_1', metadata: { user_id: me.id } });
    w = await webhook({ id: 'evt_4', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1' } } });
    r = await a.req('GET', '/api/me'); check('abonnement annulé', r.data.entitlement.state === 'canceled' && !r.data.entitlement.canWrite, r.data);
  }

  // --- Admin ---
  r = await a.req('GET', '/api/admin/metrics'); check('admin sans jeton 404', r.status === 404);
  r = await a.req('GET', '/api/admin/metrics', undefined, { headers: { authorization: 'Bearer mauvais' } }); check('admin mauvais jeton 404', r.status === 404);
  r = await a.req('GET', '/api/admin/metrics', undefined, { headers: { authorization: `Bearer ${ADMIN}` } });
  check('admin metrics', r.status === 200 && r.data.invoices.count === 2 && r.data.funnel.users >= 2 && r.data.funnel.activatedUsers >= 1 && r.data.events30d.signup >= 2, r.data);
  r = await a.req('GET', '/api/admin/users', undefined, { headers: { authorization: `Bearer ${ADMIN}` } });
  check('admin users', r.status === 200 && r.data.users.some((u) => u.email === email), r.data);

  // --- Réinitialisation ---
  r = await new Client().req('POST', '/api/auth/reset/request', { email });
  check('reset demande', r.status === 200 && r.data.ok && r.data.emailDelivery === false, r.data);
  r = await a.req('POST', '/api/admin/reset-link', { email }, { origin: null, headers: { authorization: `Bearer ${ADMIN}` } });
  check('admin lien reset', r.status === 200 && r.data.link.includes('/reinitialiser?token='), r.data);
  const token = decodeURIComponent(r.data.link.split('token=')[1]);
  const c = new Client();
  r = await c.req('POST', '/api/auth/reset/confirm', { token: 'faux', password: 'nouveaumdp1' }); check('reset faux jeton', r.status === 400, r.data);
  r = await c.req('POST', '/api/auth/reset/confirm', { token, password: 'nouveaumdp1' }); check('reset ok', r.status === 200 && c.cookie, r.data);
  r = await c.req('POST', '/api/auth/reset/confirm', { token, password: 'encoreautre1' }); check('jeton à usage unique', r.status === 400, r.data);
  r = await a.req('GET', '/api/me'); check('anciennes sessions révoquées', r.status === 401, r.status);
  r = await a.req('POST', '/api/auth/login', { email, password: 'nouveaumdp1' }); check('login nouveau mdp', r.status === 200, r.data);

  // --- Suppression du compte ---
  r = await a.req('DELETE', '/api/me', { password: 'mauvais' }); check('suppression mauvais mdp', r.status === 401, r.data);
  r = await a.req('DELETE', '/api/me', { password: 'nouveaumdp1' }); check('suppression compte', r.status === 200, r.data);
  r = await a.req('POST', '/api/auth/login', { email, password: 'nouveaumdp1' }); check('compte disparu', r.status === 401, r.data);

  // --- Limitation des tentatives ---
  const d = new Client();
  let last;
  for (let i = 0; i < 11; i++) last = await d.req('POST', '/api/auth/login', { email: `cible+${uniq}@exemple.ca`, password: 'x' });
  check('limite de tentatives 429', last.status === 429, last.data);

  console.log(`\n${passed} vérifications réussies, ${failures.length} échec(s).`);
  for (const f of failures) console.log('  ✗', f);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
