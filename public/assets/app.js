import { api, ApiStore, LocalStore, previewQuote } from './store.js';
import {
  h, toast, todayISO, toISO, addDays, daysBetween, dateLong, relDays, relTime, money, money2, moneyRound, fold, ordinal,
  copyText, download, toCsv, toJsonExport, normalizeImported, detectLocalQuotes, validateQuote,
} from './utils.js';
import { createLineEditor, decimalText, emptyLine, toEditable } from './line-editor.js';
import { buildMessage, buildInvoiceMessage, mailtoHref, smsHref, suggestedNextDays } from './templates.js';
import { createInvoicesUI } from './invoices-ui.js';
import { createCatalogUI } from './catalog-ui.js';
import { createSignUI } from './sign-ui.js';
import { createOutbox, registerServiceWorker, clearOfflineData, isTmpId } from './offline.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const MIGRATED_KEY = 'sp_migrated_v2';
const pct = new Intl.NumberFormat('fr-CA', { style: 'percent', maximumFractionDigits: 0 });

const state = {
  store: null,
  me: null,
  quotes: [],
  legacy: [],
  filter: 'all',
  search: '',
  editingId: null,
  followUpTouched: false,
  channel: 'email',
  detailed: false,
  lines: [],
  sendMode: false,
  announcements: [],
  lastRefresh: 0,
  invoices: [],
  catalog: [],
  view: { '#factures': 'invoices', '#soumissions': 'quotes' }[location.hash] || 'today',
  msg: null,
  showCosts: false,
};
// Boîte d'envoi hors ligne (compte synchronisé seulement).
let outbox = null;

const isDemo = () => state.store && state.store.mode === 'demo';
const ent = () => (state.me && state.me.entitlement) || {};
const canWrite = () => isDemo() || Boolean(ent().canWrite);
const billingOn = () => Boolean(state.me && state.me.billing && state.me.billing.enabled);
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

// =============== Démarrage ===============
async function boot() {
  wireStatic();
  if (params.has('demo')) {
    state.store = new LocalStore();
  } else {
    try {
      state.me = await api('/api/me');
      state.store = new ApiStore();
    } catch (err) {
      if (err.status === 401) {
        location.replace(`/connexion?next=${encodeURIComponent('/app')}`);
        return;
      }
      $('loading').textContent = err.message;
      return;
    }
    if (!localStorageFlag(MIGRATED_KEY)) state.legacy = detectLocalQuotes([MIGRATED_KEY]);
    outbox = createOutbox({ userId: state.me.user.id, onChange: renderNet });
    registerServiceWorker();
  }
  state.showCosts = localStorageFlag('sp_show_costs') === '1';
  $('showCosts').checked = state.showCosts;
  try {
    await reload();
    await invoicesUI.load();
  } catch (err) {
    $('loading').textContent = err.message;
    return;
  }
  try { await catalogUI.load(); } catch { /* bibliothèque indisponible pour l'instant */ }
  $('loading').hidden = true;
  $('content').hidden = false;
  $('newBtn').hidden = false;
  $('bottomNav').hidden = false;
  announceDecisions();
  render();
  setView(state.view);
  handleReturnParams();
  window.addEventListener('online', flushOutbox);
  window.addEventListener('offline', renderNet);
  if (outbox && outbox.count() && navigator.onLine) flushOutbox();
}

function localStorageFlag(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* stockage indisponible */ }
  return null;
}

const FORM_KEYS = ['client', 'project', 'amount', 'detailed', 'items', 'subtotal', 'discount', 'taxes', 'gst', 'qst', 'status', 'sentOn',
  'followUpOn', 'validUntil', 'clientEmail', 'clientPhone', 'clientAddress', 'notes', 'terms', 'subcontract', 'denouncedOn'];

/** Liste du serveur + ce qui attend dans la boîte d'envoi (brouillons, modifications, signatures hors ligne). */
async function reload() {
  const server = await state.store.list();
  if (!outbox) { state.quotes = server; return; }
  const merged = server.map((q) => {
    const pend = outbox.pendingUpdate(q.id);
    let out = q;
    if (pend) {
      try {
        const p = previewQuote(pend, { id: q.id, createdAt: q.createdAt });
        out = { ...q, ...Object.fromEntries(FORM_KEYS.map((k) => [k, p[k]])), pendingSync: true };
      } catch { out = { ...q, pendingSync: true }; }
    }
    if (outbox.pendingSign(q.id)) out = { ...out, status: 'accepted', pendingSync: true };
    return out;
  });
  const drafts = [];
  for (const e of outbox.drafts()) {
    try {
      drafts.push({ ...previewQuote(e.body, { id: e.tmpId, createdAt: e.at }), offlineDraft: true, syncError: e.error || null });
    } catch { /* brouillon illisible : ignoré à l'affichage */ }
  }
  state.quotes = [...drafts, ...merged];
}

// =============== Hors ligne ===============
function renderNet() {
  const chip = $('netChip');
  if (!chip) return;
  const pending = outbox ? outbox.count() : 0;
  if (!navigator.onLine) {
    chip.hidden = false;
    chip.textContent = pending ? `Hors ligne · ${pending}` : 'Hors ligne';
    chip.title = pending ? `${plural(pending, 'changement attend', 'changements attendent')} le réseau` : 'Pas de réseau : tu vois tes dernières données';
  } else if (pending) {
    chip.hidden = false;
    chip.textContent = `${pending} à envoyer`;
    chip.title = '';
  } else chip.hidden = true;
  chip.parentElement.classList.toggle('has-net', !chip.hidden);
}

async function flushOutbox() {
  renderNet();
  if (!outbox || !outbox.count() || !navigator.onLine) return;
  const r = await outbox.flush();
  if (r.sent) {
    try {
      await reload();
      await invoicesUI.load();
    } catch { /* on réessaiera */ }
    render();
    toast(`Réseau retrouvé : ${plural(r.sent, 'changement envoyé', 'changements envoyés')}.`);
  }
  if (r.failed) toast(`${plural(r.failed, 'brouillon refusé', 'brouillons refusés')} : ouvre-le pour corriger.`, { error: true });
  renderNet();
}

async function refreshMe() {
  if (isDemo()) return;
  try {
    state.me = await api('/api/me');
  } catch (err) {
    if (err.status === 401) location.replace('/connexion');
  }
  render();
}

function handleReturnParams() {
  const billing = params.get('facturation');
  if (params.has('bienvenue')) {
    toast(state.legacy.length
      ? 'Compte créé. Tu peux importer tes soumissions de la démo juste en haut.'
      : 'Compte créé. Ajoute la dernière soumission que tu as envoyée.');
  }
  if (billing === 'ok') {
    toast('Paiement reçu. Activation de ton abonnement…');
    pollActivation(6);
  } else if (billing === 'annule') {
    toast('Paiement annulé. Rien n’a été facturé.');
  }
  if (params.has('bienvenue') || billing) history.replaceState(null, '', isDemo() ? '/app?demo=1' : '/app');
}

async function pollActivation(triesLeft) {
  await refreshMe();
  if (ent().state === 'active') {
    toast('Ton abonnement est actif. Merci de faire partie des fondateurs!');
    return;
  }
  if (triesLeft > 0) setTimeout(() => pollActivation(triesLeft - 1), 2000);
  else toast('Le paiement est en traitement. Recharge la page dans une minute.');
}

function handleError(err) {
  if (err && err.status === 401) {
    location.replace('/connexion?next=%2Fapp');
    return;
  }
  toast((err && err.message) || 'Erreur inattendue.', { error: true });
  if (err && err.status === 402) refreshMe();
}

function requireWrite() {
  if (canWrite()) return true;
  toast('Ton compte est en lecture seule. Active ton abonnement pour continuer.', { error: true });
  openAccount();
  return false;
}

// =============== Calculs ===============
function isDue(q, today) {
  return q.status === 'pending' && q.followUpOn && q.followUpOn <= today;
}

function followTag(q, today) {
  if (q.offlineDraft) return h('span', { class: 'tag tag-due', text: q.syncError ? `Brouillon refusé : ${q.syncError}` : 'Brouillon sur ce téléphone' });
  if (q.status === 'accepted') {
    return h('span', { class: 'tag tag-go', text: q.signedInPerson ? 'Signée sur place' : (q.decidedOnlineAt ? 'Acceptée en ligne' : 'Acceptée') });
  }
  if (q.status === 'refused') return h('span', { class: 'tag tag-stop', text: q.decidedOnlineAt ? 'Refusée en ligne' : 'Refusée' });
  if (!q.followUpOn) return h('span', { class: 'tag', text: 'Aucune relance prévue' });
  const d = daysBetween(today, q.followUpOn);
  if (d < 0) return h('span', { class: 'tag tag-late', text: `En retard de ${plural(-d, 'jour', 'jours')}` });
  if (d === 0) return h('span', { class: 'tag tag-due', text: 'Relance aujourd’hui' });
  return h('span', { class: 'tag', text: `Relance ${d === 1 ? 'demain' : `le ${dateLong(q.followUpOn)}`}` });
}

const HOT_MS = 48 * 3600 * 1000;
function isHot(q) {
  return q.status === 'pending' && Boolean(q.lastViewedAt) && Date.now() - q.lastViewedAt < HOT_MS;
}

function viewTag(q) {
  if (q.status !== 'pending') return null;
  if (q.viewCount > 0) {
    return h('span', { class: `tag ${isHot(q) ? 'tag-hot' : ''}`, text: `Ouverte ${q.viewCount} fois, ${relTime(q.lastViewedAt)}` });
  }
  if (q.shareToken) return h('span', { class: 'tag', text: 'Lien envoyé, pas encore ouverte' });
  return null;
}

// =============== Rendu ===============
const VIEW_HASH = { today: '', quotes: '#soumissions', invoices: '#factures' };

function setView(view) {
  state.view = VIEW_HASH[view] === undefined ? 'today' : view;
  $('todayView').hidden = state.view !== 'today';
  $('quotesView').hidden = state.view !== 'quotes';
  $('invoicesView').hidden = state.view !== 'invoices';
  document.querySelectorAll('#bottomNav [data-view]').forEach((b) => {
    if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $('newBtn').hidden = state.view === 'invoices';
  try { history.replaceState(null, '', `${location.pathname}${location.search}${VIEW_HASH[state.view]}`); } catch { /* aperçu */ }
}

function render() {
  invoicesUI.renderView();
  renderPlan();
  renderBanners();
  renderStats();
  renderLists();
  renderToday();
  renderNet();
  $('newBtn').setAttribute('aria-disabled', canWrite() ? 'false' : 'true');
}

function renderPlan() {
  const chip = $('planChip');
  chip.hidden = false;
  chip.classList.remove('is-warn');
  if (isDemo()) {
    chip.textContent = 'Démo';
    return;
  }
  const e = ent();
  if (e.state === 'trial') {
    chip.textContent = `Essai : ${e.trialDaysLeft} j`;
    chip.classList.toggle('is-warn', e.trialDaysLeft <= 3);
  } else if (e.state === 'active') {
    chip.textContent = 'Abonné';
  } else if (e.state === 'past_due') {
    chip.textContent = 'Paiement à régler';
    chip.classList.add('is-warn');
  } else if (e.grace) {
    chip.textContent = 'Accès prolongé';
  } else {
    chip.textContent = 'Lecture seule';
    chip.classList.add('is-warn');
  }
}

function banner(tone, text, actions = []) {
  return h('div', { class: `banner ${tone ? `is-${tone}` : ''}` },
    h('div', { class: 'wrap' },
      h('p', {}, text),
      actions.length ? h('div', { class: 'banner-actions' }, actions) : null));
}

function renderBanners() {
  const out = [];
  for (const q of state.announcements) {
    const dismiss = () => { state.announcements = state.announcements.filter((x) => x.id !== q.id); renderBanners(); };
    const text = q.status === 'accepted'
      ? `${q.decidedByName || q.client} a accepté « ${q.project} » en ligne (${money2(q.amount)}). Appelle pour planifier les travaux.`
      : `${q.client} a refusé « ${q.project} » en ligne.${q.clientMessage ? ` Raison : « ${q.clientMessage} »` : ''}`;
    out.push(banner(q.status === 'accepted' ? 'go' : '', text, [
      q.status === 'accepted'
        ? h('button', { class: 'btn btn-ink btn-sm', type: 'button', onClick: () => { dismiss(); invoicesUI.createFromQuote(q.id).then(() => setView('invoices')); } }, 'Créer la facture')
        : h('button', { class: 'btn btn-ink btn-sm', type: 'button', onClick: () => { dismiss(); openQuote(q.id); } }, 'Voir la soumission'),
      h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onClick: dismiss }, 'OK'),
    ]));
  }
  if (isDemo()) {
    out.push(banner('ink', 'Mode démo : tes données restent dans ce navigateur. Crée ton compte gratuit pour les retrouver sur ton cellulaire et ton ordinateur.', [
      h('a', { class: 'btn btn-primary btn-sm', href: '/connexion?mode=inscription' }, 'Créer mon compte'),
    ]));
  } else {
    const e = ent();
    const activate = (label = 'Activer l’abonnement') => h('button', { class: 'btn btn-ink btn-sm', type: 'button', onClick: startCheckout }, label);
    if (state.legacy.length) {
      out.push(banner('warn', `${plural(state.legacy.length, 'soumission trouvée', 'soumissions trouvées')} dans la démo de ce navigateur. Les ajouter à ton compte?`, [
        h('button', { class: 'btn btn-ink btn-sm', type: 'button', onClick: importLegacy }, 'Importer'),
        h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onClick: dismissLegacy }, 'Ignorer'),
      ]));
    }
    if (e.state === 'past_due') {
      out.push(banner('warn', 'Le dernier paiement n’a pas passé. Mets ta carte à jour pour garder ton accès.', [
        h('button', { class: 'btn btn-ink btn-sm', type: 'button', onClick: openPortal }, 'Mettre à jour le paiement'),
      ]));
    } else if (!e.canWrite) {
      const text = e.state === 'canceled'
        ? 'Ton abonnement est terminé. Tes soumissions restent consultables et exportables. Réactive-le pour en ajouter et faire tes relances.'
        : 'Ton essai est terminé. Tes soumissions restent consultables et exportables. Active ton abonnement pour en ajouter et faire tes relances.';
      out.push(banner('warn', text, [activate(e.state === 'canceled' ? 'Réactiver l’abonnement' : 'Activer l’abonnement')]));
    } else if (e.grace) {
      out.push(banner('', 'Ton essai est terminé, mais les abonnements ne sont pas encore ouverts : tu gardes l’accès complet d’ici là.', []));
    } else if (e.state === 'trial' && e.trialDaysLeft <= 3) {
      out.push(banner('', `Il reste ${plural(e.trialDaysLeft, 'jour', 'jours')} à ton essai. À la fin, rien ne se perd : tes soumissions restent consultables.`,
        billingOn() ? [activate()] : []));
    }
  }
  $('banners').replaceChildren(...out);
}

function renderStats() {
  const today = todayISO();
  let dueN = 0, dueV = 0, pendN = 0, pendV = 0, accN = 0, accV = 0, refN = 0;
  for (const q of state.quotes) {
    if (q.status === 'pending') {
      pendN++; pendV += q.amount;
      if (isDue(q, today)) { dueN++; dueV += q.amount; }
    } else if (q.status === 'accepted') { accN++; accV += q.amount; } else refN++;
  }
  const decided = accN + refN;
  const stat = (label, value, sub, extra = '') => h('div', { class: `stat ${extra}` },
    h('dt', {}, label), h('dd', {}, value), h('span', { class: 'sub' }, sub));
  $('stats').replaceChildren(
    stat('À relancer', String(dueN), dueN ? moneyRound(dueV) : 'Rien en retard', dueN ? 'is-due' : ''),
    stat('En attente', moneyRound(pendV), plural(pendN, 'soumission', 'soumissions')),
    stat('Acceptées', moneyRound(accV), plural(accN, 'soumission', 'soumissions')),
    stat('Taux d’acceptation', decided ? pct.format(accN / decided) : '—', decided ? `${accN} sur ${decided} décidées` : 'Aucune décidée'),
  );
}

function slip(q, today, { due = false } = {}) {
  const classes = ['slip'];
  if (isDue(q, today)) classes.push('is-due');
  if (q.status === 'accepted') classes.push('is-accepted');
  if (q.status === 'refused') classes.push('is-refused');
  const sentAgo = daysBetween(q.sentOn, today);
  const meta = [
    followTag(q, today),
    viewTag(q),
    q.pendingSync ? h('span', { class: 'tag' }, 'En attente de réseau') : null,
    h('span', {}, due ? `Envoyée ${relDays(-sentAgo)}` : `Envoyée le ${dateLong(q.sentOn)}`),
    q.followUpCount ? h('span', {}, plural(q.followUpCount, 'relance faite', 'relances faites')) : null,
    q.number ? h('span', { class: 'num' }, `N° ${q.number}`) : null,
  ];
  const actions = due ? h('div', { class: 'slip-actions' },
    h('button', { class: 'btn btn-ink btn-sm', type: 'button', onClick: () => openFollow(q.id) }, 'Relancer'),
    h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onClick: () => setStatus(q.id, 'accepted') }, 'Acceptée'),
    h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onClick: () => setStatus(q.id, 'refused') }, 'Refusée'),
  ) : null;
  return h('article', { class: classes.join(' ') },
    due ? h('span', { class: 'slip-perf', 'aria-hidden': 'true' }) : null,
    h('div', { class: 'slip-head' },
      h('button', { class: 'slip-open', type: 'button', onClick: () => openQuote(q.id), 'aria-label': `Modifier : ${q.client}, ${q.project}` },
        h('span', { class: 'slip-client' }, q.client)),
      h('span', { class: 'slip-amount' }, money(q.amount))),
    h('p', { class: 'slip-project' }, q.project),
    h('div', { class: 'slip-meta' }, meta),
    q.clientMessage ? h('p', { class: 'slip-note' }, `${q.decidedByName || q.client} : « ${q.clientMessage} »`) : null,
    actions);
}

function renderLists() {
  const today = todayISO();
  const needle = fold(state.search.trim());
  const filtered = state.quotes.filter((q) =>
    (state.filter === 'all' || q.status === state.filter)
    && (!needle || fold(`${q.client} ${q.project} ${q.notes || ''}`).includes(needle)));
  $('allCount').textContent = String(filtered.length);
  $('allList').replaceChildren(...(filtered.length
    ? filtered.map((q) => slip(q, today))
    : [h('div', { class: 'empty' }, state.quotes.length ? 'Aucune soumission ne correspond à ta recherche.' : 'Tes soumissions apparaîtront ici.')]));
}

// =============== Aujourd'hui ===============
const btnSm = (label, onClick, cls = 'btn-ink') => h('button', { class: `btn ${cls} btn-sm`, type: 'button', onClick }, label);

function card(tone, kicker, text, actions = []) {
  return h('article', { class: `slip today-card ${tone ? `is-${tone}` : ''}` },
    h('span', { class: 'slip-perf', 'aria-hidden': 'true' }),
    h('p', { class: 'today-kicker' }, kicker),
    h('p', { class: 'today-text' }, text),
    actions.length ? h('div', { class: 'slip-actions' }, actions) : null);
}

function telHref(phone) {
  const digits = String(phone || '').replace(/[^0-9+]/g, '');
  return digits ? `tel:${digits}` : '';
}

function hotCard(q) {
  const tel = telHref(q.clientPhone);
  return card('hot', 'Client chaud',
    `${q.client} a ouvert « ${q.project} » ${relTime(q.lastViewedAt)} (${plural(q.viewCount, 'ouverture', 'ouvertures')}). C’est le meilleur moment pour appeler.`,
    [tel ? h('a', { class: 'btn btn-ink btn-sm', href: tel }, 'Appeler') : null,
      btnSm(tel ? 'Écrire' : 'Relancer', () => openFollow(q.id), tel ? 'btn-quiet' : 'btn-ink')].filter(Boolean));
}

function renderToday() {
  const today = todayISO();
  const cards = [];
  const invoices = state.invoices || [];
  let shieldN = 0;

  // 1. Bouclier Paiement : délais de l'hypothèque légale des factures impayées
  for (const inv of invoices) {
    const sh = invoicesUI.shield(inv, today);
    if (!sh || sh.phase === 'past') continue;
    const overdue = invoicesUI.isOverdue(inv, today);
    if (sh.phase === 'lien' && !sh.urgent) continue;
    if (sh.phase === 'preavis' && !overdue) continue;
    shieldN++;
    cards.push(card('alert', 'Bouclier Paiement', sh.phase === 'lien'
      ? `${inv.client} · facture n° ${inv.number} · ${money2(inv.total)} impayés. Il te reste ${sh.daysToLien === 0 ? 'aujourd’hui seulement' : plural(sh.daysToLien, 'jour', 'jours')} pour protéger ton paiement : inscription de l’hypothèque légale d’ici le ${dateLong(sh.lienBy)}.`
      : `${inv.client} · facture n° ${inv.number} toujours impayée. Si l’hypothèque légale est inscrite : préavis d’exercice avant le ${dateLong(sh.preavisBy)}.`,
    [h('a', { class: 'btn btn-ink btn-sm', href: invoicesUI.dossierUrl(inv), target: '_blank', rel: 'noopener' }, 'Préparer le dossier'),
      btnSm('Voir la facture', () => invoicesUI.open(inv.id), 'btn-quiet')]));
  }
  for (const inv of invoices) {
    if (inv.kind === 'deposit' || inv.status !== 'unpaid' || inv.workEndOn || !invoicesUI.isOverdue(inv, today)) continue;
    cards.push(card('alert', 'Protège ce paiement',
      `La facture n° ${inv.number} de ${inv.client} est en retard. Inscris la date de fin des travaux : l’app calcule tes délais d’hypothèque légale.`,
      [btnSm('Ajouter la date', () => invoicesUI.open(inv.id))]));
  }

  // 2. Sous-traitance : dénoncer le contrat au propriétaire avant les travaux
  for (const q of state.quotes) {
    if (q.status !== 'accepted' || !q.subcontract || q.denouncedOn || q.offlineDraft) continue;
    cards.push(card('alert', 'Sous-traitance',
      `« ${q.project} » pour ${q.client} : dénonce ton contrat par écrit au propriétaire de l’immeuble avant de commencer, pour garder ta protection de paiement.`,
      [btnSm('C’est fait', () => markDenounced(q.id)), btnSm('Voir', () => openQuote(q.id), 'btn-quiet')]));
  }

  // 3. Signée au domicile du client : délai d'annulation possible
  for (const q of state.quotes) {
    if (q.status !== 'accepted' || !q.signedAtHome || !q.decidedOnlineAt) continue;
    const signedOn = toISO(new Date(q.decidedOnlineAt));
    const until = addDays(signedOn, 10);
    if (until < today) continue;
    cards.push(card('', 'Signée à domicile',
      `${q.client} a signé « ${q.project} » le ${dateLong(signedOn)} et peut avoir jusqu’au ${dateLong(until)} pour annuler. Valide avec ton avocat avant de commencer les travaux.`,
      [btnSm('Voir', () => openQuote(q.id), 'btn-quiet')]));
  }

  // 4. Clients chauds, puis relances du jour (les plus chaudes d'abord)
  const hot = state.quotes.filter((q) => isHot(q) && !isDue(q, today));
  cards.push(...hot.map(hotCard));
  const due = state.quotes.filter((q) => !q.offlineDraft && isDue(q, today))
    .sort((a, b) => (Number(isHot(b)) - Number(isHot(a)))
      || (a.followUpOn < b.followUpOn ? -1 : a.followUpOn > b.followUpOn ? 1 : b.amount - a.amount));
  cards.push(...due.map((q) => slip(q, today, { due: true })));

  // 5. Prix bientôt échus : une raison vraie de relancer
  for (const q of state.quotes) {
    if (q.status !== 'pending' || !q.validUntil || isDue(q, today) || isHot(q) || q.offlineDraft) continue;
    const d = daysBetween(today, q.validUntil);
    if (d < 0 || d > 3) continue;
    cards.push(card('', 'Prix garantis bientôt échus',
      `« ${q.project} » de ${q.client} est valide jusqu’au ${dateLong(q.validUntil)}. Bon moment pour un dernier suivi.`,
      [btnSm('Relancer', () => openFollow(q.id))]));
  }

  // 6. Argent à encaisser : acomptes, factures en retard
  const deposits = invoices.filter((inv) => inv.kind === 'deposit' && inv.status === 'unpaid');
  cards.push(...deposits.map((inv) => invoicesUI.slip(inv, today, { actions: true })));
  const late = invoices.filter((inv) => inv.kind !== 'deposit' && invoicesUI.isOverdue(inv, today));
  cards.push(...late.map((inv) => invoicesUI.slip(inv, today, { actions: true })));

  // 7. Acceptées sans facture (60 derniers jours)
  if (!isDemo()) {
    for (const q of state.quotes) {
      if (q.status !== 'accepted' || q.offlineDraft || q.pendingSync || invoicesUI.invoiceFor(q.id)) continue;
      if (Date.now() - (q.decidedOnlineAt || q.updatedAt) > 60 * 864e5) continue;
      cards.push(card('go', 'Acceptée',
        `${q.client} · « ${q.project} » · ${money2(q.amount)}. Travaux terminés? La facture se crée en un geste, acompte déjà déduit.`,
        [btnSm('Créer la facture', () => invoicesUI.createFromQuote(q.id).then(() => setView('invoices'))),
          btnSm('Voir', () => openQuote(q.id), 'btn-quiet')]));
    }
  }

  const lateSum = late.reduce((sum, inv) => sum + inv.total, 0);
  const parts = [
    due.length ? plural(due.length, 'relance', 'relances') : null,
    state.quotes.filter(isHot).length ? plural(state.quotes.filter(isHot).length, 'client chaud', 'clients chauds') : null,
    late.length ? `${plural(late.length, 'facture en retard', 'factures en retard')} (${moneyRound(lateSum)})` : null,
    deposits.length ? plural(deposits.length, 'acompte à encaisser', 'acomptes à encaisser') : null,
    shieldN ? plural(shieldN, 'paiement à protéger', 'paiements à protéger') : null,
  ].filter(Boolean);
  const actionable = cards.length;
  $('todayCount').textContent = actionable ? String(actionable) : '';
  $('todayTabCount').textContent = actionable ? String(actionable) : '';

  if (!state.quotes.length) {
    $('todaySummary').textContent = 'Bienvenue. Commence par ta dernière soumission envoyée : la relance se planifie toute seule.';
    $('todayList').replaceChildren(h('div', { class: 'empty' },
      h('strong', {}, 'Aucune soumission pour l’instant.'),
      'Monte ta bibliothèque une fois (tes taux, tes matériaux, tes forfaits) : tes prochaines soumissions se font en moins d’une minute.',
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-ink', type: 'button', onClick: () => { if (requireWrite()) openQuote(); } }, 'Nouvelle soumission'),
        isDemo() ? null : h('button', { class: 'btn btn-ghost on-paper', type: 'button', onClick: () => catalogUI.open({ manage: true }) }, 'Monter ma bibliothèque'))));
    return;
  }
  if (!cards.length) {
    const next = state.quotes.filter((q) => q.status === 'pending' && q.followUpOn && q.followUpOn > today)
      .sort((a, b) => (a.followUpOn < b.followUpOn ? -1 : 1))[0];
    $('todaySummary').textContent = 'Rien d’urgent aujourd’hui.';
    $('todayList').replaceChildren(h('div', { class: 'empty' },
      h('strong', {}, 'Tout est à jour.'),
      next ? `Prochaine relance : ${next.client}, ${relDays(daysBetween(today, next.followUpOn))}.` : 'Aucune relance planifiée. Une nouvelle soumission?'));
    return;
  }
  $('todaySummary').textContent = parts.length ? `${parts.join(' · ')}.` : 'À faire aujourd’hui.';
  $('todayList').replaceChildren(...cards);
}

async function markDenounced(id) {
  if (!requireWrite()) return;
  const q = state.quotes.find((x) => x.id === id);
  if (!q) return;
  try {
    await state.store.update(id, { ...q, denouncedOn: todayISO() });
    await reload();
    render();
    toast('Dénonciation notée. Garde ta preuve d’envoi au dossier.');
  } catch (e) { handleError(e); }
}

// =============== Soumission (ajout / modification) ===============
const FIELDS = ['client', 'project', 'amount', 'status', 'sentOn', 'followUpOn', 'clientEmail', 'clientPhone', 'notes',
  'discount', 'validUntil', 'clientAddress', 'terms'];
const DETAIL_ONLY = ['discount', 'validUntil', 'clientAddress', 'terms'];

function businessDefaults() {
  const b = state.me && state.me.user && state.me.user.business;
  return { taxes: b ? b.chargeTaxes : true, terms: b ? b.defaultTerms : '' };
}

function clearErrors(form) {
  form.querySelectorAll('.has-error').forEach((el) => el.classList.remove('has-error'));
  form.querySelectorAll('.field-error').forEach((el) => el.remove());
  $('quoteError').hidden = true;
}

function showFieldError(form, field, message) {
  const line = field && field.match(/^items\.(\d+)\.(\w+)$/);
  let wrap = null;
  if (line) {
    const input = $(`line-${line[2]}-${line[1]}`);
    wrap = input ? input.closest('.field') : null;
  } else if (field) {
    wrap = form.querySelector(`[data-field="${field}"]`);
  }
  if (!wrap || wrap.closest('[hidden]')) {
    $('quoteError').textContent = message;
    $('quoteError').hidden = false;
    $('quoteError').scrollIntoView({ block: 'nearest' });
    return;
  }
  wrap.classList.add('has-error');
  wrap.append(h('span', { class: 'field-error' }, message));
  const input = wrap.querySelector('input, select, textarea');
  if (input) input.focus();
}

// Éditeur de lignes de la soumission (créé au démarrage, voir wireStatic).
let quoteLines = null;

function setDetailed(on, { seedFromAmount = false } = {}) {
  const form = $('quoteForm');
  if (on && seedFromAmount && !quoteLines.lines.length) {
    const amount = form.elements.amount.value.trim();
    quoteLines.set([amount
      ? { description: form.elements.project.value.trim() || 'Travaux', qty: '1', unit: 'forfait', unitPrice: amount }
      : emptyLine()]);
  }
  if (!on && state.detailed) {
    // Retour au montant simple : le total calculé devient le montant.
    const t = quoteLines.totals();
    if (t && !t.error && t.totalCents) form.elements.amount.value = decimalText((t.totalCents / 100).toFixed(2));
  }
  state.detailed = on;
  quoteLines.setActive(on);
  if (on) quoteLines.ensureOne();
  $('detailBox').hidden = !on;
  $('detailHint').hidden = on;
  $('detailToggle').setAttribute('aria-expanded', String(on));
  $('detailToggle').textContent = on ? 'Revenir à un montant simple' : 'Détailler avec lignes et TPS/TVQ';
  form.querySelector('[data-field="amount"]').hidden = on;
}

function openQuote(id = null, { duplicateOf = null } = {}) {
  const form = $('quoteForm');
  clearErrors(form);
  const q = id ? state.quotes.find((x) => x.id === id) : null;
  const src = duplicateOf ? state.quotes.find((x) => x.id === duplicateOf) : null;
  state.editingId = q ? q.id : null;
  state.followUpTouched = Boolean(q);
  $('quoteTitle').textContent = q
    ? (q.offlineDraft ? 'Brouillon (hors ligne)' : `Soumission${q.number ? ` n° ${q.number}` : ''}`)
    : (src ? `Copie de « ${src.project} »` : 'Nouvelle soumission');
  const today = todayISO();
  const defaults = businessDefaults();
  let values;
  if (q) {
    values = { ...q, amount: decimalText(q.amount), discount: q.discount ? decimalText(q.discount) : '' };
    if (!q.detailed && !q.validUntil) values.validUntil = addDays(q.sentOn || today, 30);
    if (!q.detailed && !q.terms) values.terms = defaults.terms;
  } else {
    values = { client: '', project: '', amount: '', status: 'pending', sentOn: today, followUpOn: addDays(today, 3), clientEmail: '', clientPhone: '',
      notes: '', discount: '', validUntil: addDays(today, 30), clientAddress: '', terms: defaults.terms };
    if (src) {
      // La job de la semaine passée devient celle d'aujourd'hui : mêmes lignes et conditions, nouveau client.
      Object.assign(values, { project: src.project, amount: decimalText(src.amount), discount: src.discount ? decimalText(src.discount) : '',
        terms: src.terms || defaults.terms });
    }
  }
  for (const f of FIELDS) form.elements[f].value = values[f] ?? '';
  const base = q || src;
  form.elements.taxes.checked = base && base.detailed ? base.taxes : defaults.taxes;
  form.elements.subcontract.checked = Boolean(q && q.subcontract);
  quoteLines.set(base && base.detailed ? toEditable(base.items) : []);
  state.detailed = false;
  // Nouvelle soumission : lignes et TPS/TVQ d'office ; le montant global devient l'exception.
  setDetailed(q ? Boolean(q.detailed) : (src ? Boolean(src.detailed) : true));

  const writable = canWrite();
  for (const f of FIELDS) form.elements[f].disabled = !writable;
  form.elements.taxes.disabled = !writable;
  form.elements.subcontract.disabled = !writable;
  $('detailToggle').disabled = !writable;
  $('addLine').disabled = !writable;
  $('saveQuote').hidden = !writable;
  $('saveSend').hidden = !(writable && !isDemo() && (!q || (q.status === 'pending' && !q.offlineDraft)));
  $('deleteQuote').hidden = !(q && writable);
  $('duplicateQuote').hidden = !(q && writable && !q.offlineDraft);
  $('signHere').hidden = !(q && writable && !isDemo() && q.status === 'pending' && !q.offlineDraft && !q.pendingSync);
  const existingInvoice = q && !q.offlineDraft ? invoicesUI.invoiceFor(q.id) : null;
  const deposit = q && !q.offlineDraft ? invoicesUI.depositFor(q.id) : null;
  $('makeInvoice').hidden = !(q && !q.offlineDraft && (existingInvoice || (q.status !== 'refused' && (writable || isDemo()))));
  $('makeInvoice').textContent = existingInvoice ? `Voir la facture n° ${existingInvoice.number}` : 'Créer la facture';
  $('makeDeposit').hidden = !(q && !isDemo() && q.status === 'accepted' && !q.offlineDraft && !q.pendingSync && (deposit || writable) && !existingInvoice);
  $('makeDeposit').textContent = deposit ? `Voir l’acompte n° ${deposit.number}` : 'Facture d’acompte';
  $('quoteActions').hidden = ['signHere', 'makeDeposit', 'makeInvoice', 'duplicateQuote'].every((b) => $(b).hidden);
  if (!writable) {
    $('quoteError').textContent = 'Lecture seule : active ton abonnement pour modifier tes soumissions.';
    $('quoteError').hidden = false;
  }
  updateFollowHint();
  renderNotice(q);
  renderLinkBox(q && !q.offlineDraft ? q : null);
  $('quoteDialog').showModal();
  if (!q && writable) form.elements.client.focus();
}

/** Encadré privé dans la soumission : brouillon hors ligne, signée à domicile, sous-traitance. */
function renderNotice(q) {
  const box = $('quoteNotice');
  const items = [];
  if (q && q.offlineDraft) {
    items.push(h('p', {}, q.syncError
      ? `Refusée à l’envoi : ${q.syncError} Corrige et enregistre de nouveau.`
      : 'Brouillon gardé sur ce téléphone. Il partira tout seul au retour du réseau et recevra son numéro à ce moment.'));
  }
  if (q && q.status === 'accepted' && q.signedInPerson) {
    const signedOn = q.decidedOnlineAt ? toISO(new Date(q.decidedOnlineAt)) : null;
    items.push(h('p', {}, `Signée sur place par ${q.decidedByName || q.client}${signedOn ? ` le ${dateLong(signedOn)}` : ''}.`
      + (q.signedAtHome && signedOn ? ` Signée au domicile du client : il peut avoir jusqu’au ${dateLong(addDays(signedOn, 10))} pour annuler (à valider avec ton avocat).` : '')));
  }
  if (q && q.subcontract && q.status === 'accepted') {
    items.push(h('p', {}, q.denouncedOn
      ? `Contrat dénoncé au propriétaire le ${dateLong(q.denouncedOn)}.`
      : 'Sous-traitance : dénonce ton contrat par écrit au propriétaire avant de commencer les travaux.'));
    if (!q.denouncedOn && canWrite()) {
      items.push(h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-ink btn-sm', type: 'button', onClick: async () => {
        $('quoteDialog').close();
        await markDenounced(q.id);
      } }, 'C’est fait')));
    }
  }
  box.hidden = !items.length;
  box.replaceChildren(...items);
}

function updateFollowHint() {
  const form = $('quoteForm');
  const closed = form.elements.status.value !== 'pending';
  $('followHint').textContent = closed ? 'Pas de relance pour une soumission fermée.' : '3 jours après l’envoi, par défaut.';
}

function formData() {
  const form = $('quoteForm');
  const data = Object.fromEntries(FIELDS.map((f) => [f, form.elements[f].value]));
  data.followUpOn = data.followUpOn || null;
  data.subcontract = form.elements.subcontract.checked;
  const current = state.editingId ? state.quotes.find((x) => x.id === state.editingId) : null;
  data.denouncedOn = current ? current.denouncedOn || null : null;
  if (state.detailed) {
    data.items = quoteLines.cleaned();
    data.taxes = form.elements.taxes.checked;
    data.validUntil = data.validUntil || null;
  } else {
    data.items = [];
    data.taxes = false;
    for (const f of DETAIL_ONLY) data[f] = f === 'validUntil' ? null : '';
  }
  return data;
}

async function saveQuote(event) {
  event.preventDefault();
  const form = $('quoteForm');
  clearErrors(form);
  const sendAfter = Boolean(event.submitter && event.submitter.dataset.send);
  const data = formData();
  if (state.detailed && !data.items.length) {
    quoteLines.ensureOne();
    showFieldError(form, 'items.0.description', 'Ajoute au moins une ligne, ou reviens à un montant simple.');
    return;
  }
  const err = validateQuote(data);
  if (err) {
    showFieldError(form, err.field, err.message);
    return;
  }
  const buttons = [$('saveQuote'), $('saveSend')];
  buttons.forEach((b) => { b.disabled = true; });
  const keepOffline = async (message) => {
    if (state.editingId) outbox.queueUpdate(state.editingId, data);
    else outbox.queueCreate(data);
    $('quoteDialog').close();
    await reload();
    render();
    toast(message);
  };
  try {
    const wasEditing = Boolean(state.editingId);
    if (outbox && isTmpId(state.editingId)) {
      await keepOffline('Brouillon mis à jour sur ce téléphone.');
      flushOutbox();
      return;
    }
    const saved = state.editingId ? await state.store.update(state.editingId, data) : await state.store.create(data);
    $('quoteDialog').close();
    await reload();
    render();
    if (sendAfter) await shareAndSend(saved.id);
    else toast(wasEditing ? 'Soumission mise à jour.' : 'Soumission ajoutée.');
  } catch (e) {
    if (e.status === 0 && outbox) {
      await keepOffline(sendAfter
        ? 'Pas de réseau : soumission gardée sur ce téléphone. Envoie le lien au retour du réseau.'
        : 'Pas de réseau : gardée sur ce téléphone. Elle partira toute seule au retour du réseau.');
      return;
    }
    if (e.status === 400 && e.field) showFieldError(form, e.field, e.message);
    else if (e.status === 401 || e.status === 402) { $('quoteDialog').close(); handleError(e); }
    else showFieldError(form, null, e.message);
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

async function deleteQuote() {
  const q = state.quotes.find((x) => x.id === state.editingId);
  if (!q || !confirm(`Supprimer la soumission « ${q.project} » de ${q.client}? Cette action est définitive.`)) return;
  try {
    if (q.offlineDraft) {
      outbox.removeDraft(q.id);
      $('quoteDialog').close();
      await reload();
      render();
      toast('Brouillon supprimé.');
      return;
    }
    await state.store.remove(q.id);
    $('quoteDialog').close();
    await reload();
    render();
    toast('Soumission supprimée.');
  } catch (e) { handleError(e); }
}

async function setStatus(id, status) {
  if (!requireWrite()) return;
  const q = state.quotes.find((x) => x.id === id);
  if (!q) return;
  try {
    await state.store.update(id, { ...q, status });
    await reload();
    render();
    toast(status === 'accepted' ? `Bravo! « ${q.project} » est marquée acceptée.` : `« ${q.project} » est marquée refusée.`);
  } catch (e) { handleError(e); }
}

// =============== Lien client ===============
const linkUrl = (q) => (q && q.shareToken ? `${location.origin}/s/${q.shareToken}` : '');

function renderLinkBox(q) {
  const box = $('linkBox');
  box.hidden = !q;
  if (!q) return;
  const title = h('h3', { id: 'linkTitle' }, 'Lien client');
  if (isDemo()) {
    box.replaceChildren(title,
      h('p', {}, 'Avec un compte, tu envoies un lien : ton client consulte la soumission, l’enregistre en PDF et l’accepte en ligne. Tu vois quand il l’ouvre.'),
      h('div', { class: 'btn-row' }, h('a', { class: 'btn btn-primary btn-sm', href: '/connexion?mode=inscription' }, 'Créer mon compte gratuit')));
    return;
  }
  if (!q.shareToken) {
    box.replaceChildren(title,
      h('p', {}, 'Ton client consulte la soumission, l’enregistre en PDF et l’accepte en ligne, sans créer de compte. Tu vois quand il l’ouvre.'),
      canWrite() ? h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-ink btn-sm', type: 'button', onClick: () => shareAndSend(q.id) }, 'Créer le lien et l’envoyer')) : null);
    return;
  }
  const url = linkUrl(q);
  const field = h('input', { class: 'input', id: 'linkUrl', readonly: true, 'aria-label': 'Lien de la soumission' });
  field.value = url;
  field.addEventListener('focus', () => field.select());
  const lines = [];
  if (q.decidedOnlineAt) {
    lines.push(h('p', { class: 'link-status' }, `${q.status === 'accepted' ? 'Acceptée' : 'Refusée'} en ligne${q.decidedByName ? ` par ${q.decidedByName}` : ''}, ${relTime(q.decidedOnlineAt)}.`));
  }
  if (q.clientMessage) lines.push(h('p', { class: 'link-status' }, `Message du client : « ${q.clientMessage} »`));
  lines.push(h('p', {}, q.viewCount
    ? `Ouverte ${q.viewCount} fois. Dernière ouverture ${relTime(q.lastViewedAt)}.`
    : 'Pas encore ouverte par ton client.'));
  box.replaceChildren(title, ...lines, field,
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn btn-ink btn-sm', type: 'button', onClick: () => { $('quoteDialog').close(); openFollow(q.id, { send: true }); } }, 'Envoyer au client'),
      h('button', { class: 'btn btn-ghost on-paper btn-sm', type: 'button', onClick: async () => {
        const ok = await copyText(url);
        toast(ok ? 'Lien copié.' : 'Copie impossible : sélectionne le lien et copie-le.', { error: !ok });
      } }, 'Copier le lien'),
      h('a', { class: 'btn btn-ghost on-paper btn-sm', href: url, target: '_blank', rel: 'noopener' }, 'Voir comme le client'),
      h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onClick: () => unshare(q.id) }, 'Désactiver le lien')));
}

async function shareAndSend(id) {
  if (!requireWrite()) return;
  try {
    const q = await state.store.share(id);
    await reload();
    render();
    if ($('quoteDialog').open) $('quoteDialog').close();
    openFollow(q.id, { send: true });
  } catch (e) { handleError(e); }
}

async function unshare(id) {
  if (!confirm('Désactiver ce lien? Ton client ne pourra plus ouvrir la soumission avec l’ancien lien.')) return;
  try {
    await state.store.unshare(id);
    await reload();
    render();
    renderLinkBox(state.quotes.find((x) => x.id === id));
    toast('Lien désactivé.');
  } catch (e) { handleError(e); }
}

// =============== Messages : relance, envoi, rappel de paiement ===============
const NEXT_OPTIONS = [[3, 'Dans 3 jours'], [7, 'Dans 7 jours'], [14, 'Dans 14 jours'], [0, 'Aucune']];

function signer() {
  if (isDemo() || !state.me) return {};
  const u = state.me.user;
  return { displayName: u.displayName, company: u.company, phone: u.business ? u.business.businessPhone : '' };
}

/** Destinataire du message en cours : une soumission ou une facture. */
function msgTarget() {
  const m = state.msg;
  if (!m) return null;
  return m.type === 'invoice' ? invoicesUI.find(m.id) : state.quotes.find((x) => x.id === m.id);
}

function openFollow(id, { send = false } = {}) {
  openMessage({ type: 'quote', id, kind: send ? 'send' : 'follow' });
}

function openMessage(m) {
  state.msg = m;
  const t = msgTarget();
  if (!t) return;
  state.channel = t.clientPhone && !t.clientEmail ? 'sms' : 'email';
  const isQuote = m.type === 'quote';
  if (isQuote) {
    const count = t.followUpCount || 0;
    const ago = daysBetween(t.sentOn, todayISO());
    $('followTitle').textContent = m.kind === 'send' ? `Envoyer à ${t.client}` : `Relancer ${t.client}`;
    $('followContext').textContent = m.kind === 'send'
      ? `« ${t.project} », ${money2(t.amount)}. Ton client pourra la consulter et l’accepter en ligne.`
      : `« ${t.project} », ${money(t.amount)}. Envoyée ${relDays(-ago)}. Ce sera ta ${ordinal(count + 1)} relance.${t.viewCount ? ` Ouverte ${t.viewCount} fois, ${relTime(t.lastViewedAt)}.` : ''}`;
    const suggested = suggestedNextDays(count);
    $('nextChips').replaceChildren(...NEXT_OPTIONS.map(([days, label]) => h('label', {},
      h('input', { type: 'radio', name: 'nextDays', value: String(days), checked: days === suggested }),
      h('span', {}, label))));
  } else {
    $('followTitle').textContent = m.kind === 'reminder' ? `Rappel de paiement à ${t.client}` : `Envoyer la facture à ${t.client}`;
    $('followContext').textContent = `Facture n° ${t.number}, ${money2(t.total)}, payable d’ici le ${dateLong(t.dueOn)}.${t.viewCount ? ` Ouverte ${t.viewCount} fois, ${relTime(t.lastViewedAt)}.` : ''}`;
  }
  const followUp = isQuote && m.kind === 'follow';
  $('doneBox').hidden = !followUp;
  $('sendDoneRow').hidden = followUp;
  $('sendDone').hidden = m.kind === 'reminder';
  $('reminderDone').hidden = m.kind !== 'reminder';
  $('markDone').disabled = !canWrite();
  renderFollowMessage();
  if (!$('followDialog').open) $('followDialog').showModal();
}

function renderFollowMessage() {
  const t = msgTarget();
  if (!t) return;
  document.querySelectorAll('[data-channel]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.channel === state.channel)));
  const msg = state.msg.type === 'invoice'
    ? buildInvoiceMessage(t, {
      channel: state.channel, signer: signer(), link: invoicesUI.linkUrl(t), kind: state.msg.kind,
      paymentInstructions: state.me && state.me.user.business ? state.me.user.business.paymentInstructions : '',
    })
    : buildMessage(t, { channel: state.channel, signer: signer(), link: linkUrl(t), kind: state.msg.kind === 'send' ? 'send' : 'follow' });
  $('followMessage').value = msg.body;
  $('followMessage').dataset.subject = msg.subject;
  updateSendLinks();
}

function updateSendLinks() {
  const t = msgTarget();
  if (!t) return;
  const body = $('followMessage').value;
  const mail = $('openMail');
  const sms = $('openSms');
  mail.hidden = !(state.channel === 'email' && t.clientEmail);
  sms.hidden = !(state.channel === 'sms' && t.clientPhone);
  if (!mail.hidden) mail.href = mailtoHref(t.clientEmail, $('followMessage').dataset.subject || '', body);
  if (!sms.hidden) sms.href = smsHref(t.clientPhone, body);
  const missing = state.channel === 'email' ? !t.clientEmail : !t.clientPhone;
  $('contactHint').hidden = !missing;
  $('contactHint').textContent = state.channel === 'email'
    ? 'Ajoute le courriel du client au dossier pour ouvrir le message directement dans ton application courriel.'
    : 'Ajoute le cellulaire du client au dossier pour ouvrir le texto directement.';
}

function sendDone() {
  const t = msgTarget();
  $('followDialog').close();
  if (state.msg.type === 'invoice') {
    toast(`Parfait. Tu verras ici quand ton client ouvrira la facture n° ${t.number}.`);
    return;
  }
  toast(t && t.followUpOn ? `Parfait. Relance prévue le ${dateLong(t.followUpOn)}, sauf si ton client accepte avant.` : 'Parfait.');
}

async function reminderDone() {
  const t = msgTarget();
  $('followDialog').close();
  if (t) await invoicesUI.recordReminder(t.id);
}

async function markFollowDone() {
  if (!requireWrite()) return;
  const checked = document.querySelector('input[name="nextDays"]:checked');
  const days = checked ? Number(checked.value) : 0;
  const today = todayISO();
  const btn = $('markDone');
  btn.disabled = true;
  try {
    const q = await state.store.followUp(state.msg.id, { doneOn: today, nextFollowUpOn: days ? addDays(today, days) : null });
    $('followDialog').close();
    await reload();
    render();
    toast(q.followUpOn ? `Relance notée. Prochaine : ${dateLong(q.followUpOn)}.` : 'Relance notée. Aucune autre n’est prévue.');
  } catch (e) {
    handleError(e);
  } finally {
    btn.disabled = !canWrite();
  }
}

// =============== Réponses des clients ===============
const SEEN_KEY = 'sp_seen_decisions';

function announceDecisions() {
  if (isDemo()) return;
  const seen = Number(localStorageFlag(SEEN_KEY)) || 0;
  const fresh = state.quotes.filter((q) => q.decidedOnlineAt && q.decidedOnlineAt > seen && !q.signedInPerson)
    .sort((a, b) => b.decidedOnlineAt - a.decidedOnlineAt);
  const known = new Set(state.announcements.map((q) => q.id));
  state.announcements = [...fresh.filter((q) => !known.has(q.id)), ...state.announcements].slice(0, 3);
  localStorageFlag(SEEN_KEY, String(Date.now()));
}

async function refreshQuotes() {
  if (!state.store || isDemo() || document.hidden) return;
  if (Date.now() - state.lastRefresh < 20_000) return;
  state.lastRefresh = Date.now();
  try {
    await reload();
    await invoicesUI.load();
    announceDecisions();
    render();
  } catch { /* hors ligne : on garde l'affichage actuel */ }
}

// =============== Facturation ===============
async function startCheckout() {
  try {
    const r = await api('/api/billing/checkout', { method: 'POST', body: {} });
    if (r.url) {
      location.href = r.url;
      return;
    }
    if (r.interestRecorded) {
      toast('C’est noté! On t’écrit dès l’ouverture des abonnements, au prix fondateur.');
      await refreshMe();
      if ($('accountDialog').open) openAccount();
    }
  } catch (e) { handleError(e); }
}

async function openPortal() {
  try {
    const r = await api('/api/billing/portal', { method: 'POST', body: {} });
    location.href = r.url;
  } catch (e) { handleError(e); }
}

// =============== Données ===============
function exportCsv() {
  download(`soumissions-${todayISO()}.csv`, toCsv(state.quotes), 'text/csv;charset=utf-8');
}
function exportJson() {
  download(`soumissions-${todayISO()}.json`, toJsonExport(state.quotes), 'application/json');
}

async function importFile(file) {
  if (!file) return;
  if (!requireWrite()) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('Ce fichier n’est pas un JSON lisible.', { error: true });
    return;
  }
  const quotes = normalizeImported(data);
  if (!quotes.length) {
    toast('Aucune soumission reconnue dans ce fichier.', { error: true });
    return;
  }
  try {
    const r = await state.store.importMany(quotes);
    await reload();
    render();
    toast(`${plural(r.imported, 'soumission importée', 'soumissions importées')}${r.skipped ? `, ${r.skipped} ignorée(s) (données incomplètes)` : ''}.`);
  } catch (e) { handleError(e); }
}

async function importLegacy() {
  if (!requireWrite()) return;
  try {
    const r = await state.store.importMany(state.legacy);
    localStorageFlag(MIGRATED_KEY, '1');
    state.legacy = [];
    await reload();
    render();
    toast(`${plural(r.imported, 'soumission ajoutée', 'soumissions ajoutées')} à ton compte.`);
  } catch (e) { handleError(e); }
}

function dismissLegacy() {
  localStorageFlag(MIGRATED_KEY, '1');
  state.legacy = [];
  renderBanners();
}

// =============== Compte ===============
function section(title, ...children) {
  return h('section', { class: 'acct-section' }, h('h3', {}, title), children);
}

function billingSection() {
  const e = ent();
  const u = state.me.user;
  const status = {
    trial: `Essai gratuit : il reste ${plural(e.trialDaysLeft || 0, 'jour', 'jours')}.`,
    active: 'Abonnement actif. Merci!',
    past_due: 'Le dernier paiement n’a pas passé. Mets ta carte à jour.',
    canceled: 'Abonnement terminé : ton accès est en lecture seule.',
    trial_expired: e.grace ? 'Essai terminé. Accès prolongé jusqu’à l’ouverture des abonnements.' : 'Essai terminé : ton accès est en lecture seule.',
  }[e.state] || '';
  const buttons = [];
  if (billingOn()) {
    if (e.state !== 'active') buttons.push(h('button', { class: 'btn btn-primary', type: 'button', onClick: startCheckout }, e.state === 'canceled' ? 'Réactiver l’abonnement' : 'Activer l’abonnement'));
    if (u.hasBilling) buttons.push(h('button', { class: 'btn btn-ghost on-paper', type: 'button', onClick: openPortal }, 'Gérer l’abonnement et les factures'));
  } else if (u.billingInterest) {
    buttons.push(h('p', {}, 'C’est noté : on t’écrit dès l’ouverture des abonnements, au prix fondateur.'));
  } else {
    buttons.push(h('p', {}, 'Les abonnements ouvrent bientôt. Réserve ton accès fondateur : aucun paiement maintenant.'));
    buttons.push(h('button', { class: 'btn btn-primary', type: 'button', onClick: startCheckout }, 'Réserver mon accès fondateur'));
  }
  return section('Abonnement', h('p', {}, status), h('div', { class: 'btn-row' }, buttons));
}

function openAccount() {
  const body = $('accountBody');
  const dataSection = section('Tes données',
    h('p', {}, 'Exporte tout, en tout temps. Le CSV s’ouvre dans Excel.'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn btn-ghost on-paper btn-sm', type: 'button', onClick: exportCsv }, 'Exporter en CSV'),
      h('button', { class: 'btn btn-ghost on-paper btn-sm', type: 'button', onClick: exportJson }, 'Exporter en JSON'),
      h('button', { class: 'btn btn-ghost on-paper btn-sm', type: 'button', onClick: () => $('importFile').click() }, 'Importer un fichier JSON'),
      isDemo() ? null : h('button', { class: 'btn btn-ghost on-paper btn-sm', type: 'button', onClick: invoicesUI.exportCsv }, 'Exporter les factures (CSV)')));

  if (isDemo()) {
    body.replaceChildren(
      section('Mode démo',
        h('p', {}, 'Tes données restent dans ce navigateur. Avec un compte, elles te suivent sur ton cellulaire et ton ordinateur, et tes messages sont signés à ton nom.'),
        h('div', { class: 'btn-row' }, h('a', { class: 'btn btn-primary', href: '/connexion?mode=inscription' }, 'Créer mon compte gratuit'))),
      dataSection,
      section('Repartir à zéro',
        h('p', {}, 'Efface les soumissions de la démo dans ce navigateur.'),
        h('div', { class: 'btn-row' }, h('button', {
          class: 'btn btn-quiet', type: 'button',
          onClick: async () => {
            if (!confirm('Vider toutes les soumissions de la démo?')) return;
            state.store.clear();
            await reload();
            render();
            $('accountDialog').close();
            toast('Démo vidée.');
          },
        }, 'Vider la démo'))));
    $('accountDialog').showModal();
    return;
  }

  const u = state.me.user;
  const biz = u.business || {};
  const inp = (id, value, attrs = {}) => {
    const el = h(attrs.textarea ? 'textarea' : 'input', { class: attrs.textarea ? 'textarea' : 'input', id, autocomplete: attrs.autocomplete || 'off',
      maxlength: attrs.max || null, type: attrs.type || null, inputmode: attrs.inputmode || null, placeholder: attrs.placeholder || null });
    el.value = value || '';
    return el;
  };
  const fields = {
    displayName: inp('acct-name', u.displayName, { max: '80', autocomplete: 'given-name' }),
    company: inp('acct-company', u.company, { max: '120', autocomplete: 'organization' }),
    businessPhone: inp('acct-phone', biz.businessPhone, { max: '40', type: 'tel', inputmode: 'tel', autocomplete: 'tel' }),
    businessEmail: inp('acct-bemail', biz.businessEmail, { max: '254', type: 'email', inputmode: 'email', autocomplete: 'email' }),
    businessAddress: inp('acct-address', biz.businessAddress, { max: '200', autocomplete: 'street-address' }),
    rbqNumber: inp('acct-rbq', biz.rbqNumber, { max: '30', placeholder: '1234-5678-01' }),
    gstNumber: inp('acct-gst', biz.gstNumber, { max: '30', placeholder: '123456789 RT0001' }),
    qstNumber: inp('acct-qst', biz.qstNumber, { max: '30', placeholder: '1234567890 TQ0001' }),
    defaultTerms: inp('acct-terms', biz.defaultTerms, { textarea: true, max: '4000', placeholder: 'Ex. Paiement : 30 % à la signature, solde à la fin des travaux. Prix valides 30 jours.' }),
    paymentInstructions: inp('acct-pay', biz.paymentInstructions, { textarea: true, max: '1000', placeholder: 'Ex. Virement Interac à paiement@monentreprise.ca, ou chèque à l’ordre de mon entreprise.' }),
    invoiceDueDays: inp('acct-due', String(biz.invoiceDueDays ?? 30), { max: '3', inputmode: 'numeric' }),
    depositPct: inp('acct-deposit', biz.depositPct ? String(biz.depositPct) : '', { max: '3', inputmode: 'numeric', placeholder: 'Ex. 30' }),
    marginFloorPct: inp('acct-margin', biz.marginFloorPct === null || biz.marginFloorPct === undefined ? '' : String(biz.marginFloorPct), { max: '2', inputmode: 'numeric', placeholder: 'Ex. 20' }),
  };
  const taxesBox = h('input', { type: 'checkbox', id: 'acct-taxes' });
  taxesBox.checked = biz.chargeTaxes !== false;
  const profileError = h('div', { class: 'alert alert-error', role: 'alert', hidden: true });
  // Confirmation visible à côté du bouton, en plus du message flottant.
  const savedNote = h('span', { class: 'saved-note', role: 'status', 'aria-live': 'polite' });
  const fieldWrap = (label, key, hint) => h('div', { class: 'field', dataset: { field: key } },
    h('label', { for: fields[key].id }, label), fields[key], hint ? h('span', { class: 'hint' }, hint) : null);
  const profileForm = h('form', {
    class: 'form-grid',
    onSubmit: async (ev) => {
      ev.preventDefault();
      profileError.hidden = true;
      savedNote.textContent = '';
      profileForm.querySelectorAll('.field-error').forEach((el) => el.remove());
      const v = (k) => fields[k].value;
      try {
        state.me = await api('/api/me', { method: 'PATCH', body: {
          displayName: v('displayName'), company: v('company'),
          business: {
            businessPhone: v('businessPhone'), businessEmail: v('businessEmail'), businessAddress: v('businessAddress'),
            rbqNumber: v('rbqNumber'), gstNumber: v('gstNumber'), qstNumber: v('qstNumber'),
            chargeTaxes: taxesBox.checked, defaultTerms: v('defaultTerms'),
            paymentInstructions: v('paymentInstructions'), invoiceDueDays: v('invoiceDueDays'),
            depositPct: v('depositPct'), marginFloorPct: v('marginFloorPct'),
          },
        } });
        render();
        savedNote.textContent = `Profil enregistré à ${new Intl.DateTimeFormat('fr-CA', { timeStyle: 'short' }).format(new Date())}.`;
        toast('Profil enregistré.');
      } catch (e) {
        const wrap = e.field && profileForm.querySelector(`[data-field="${e.field}"]`);
        if (wrap) { wrap.append(h('span', { class: 'field-error' }, e.message)); fields[e.field].focus(); }
        else { profileError.textContent = e.message; profileError.hidden = false; }
        if (e.status === 401) handleError(e);
      }
    },
  },
  profileError,
  h('div', { class: 'form-row' }, fieldWrap('Prénom', 'displayName'), fieldWrap('Entreprise', 'company')),
  h('div', { class: 'form-row' }, fieldWrap('Téléphone', 'businessPhone'), fieldWrap('Courriel d’affaires', 'businessEmail')),
  fieldWrap('Adresse', 'businessAddress'),
  fieldWrap('Licence RBQ', 'rbqNumber', 'Affichée sur tes soumissions. Obligatoire pour la plupart des travaux de construction.'),
  h('div', { class: 'form-row' }, fieldWrap('N° de TPS', 'gstNumber'), fieldWrap('N° de TVQ', 'qstNumber')),
  h('label', { class: 'check check-box' }, taxesBox, h('span', {}, 'Ajouter TPS et TVQ par défaut à mes soumissions détaillées')),
  fieldWrap('Conditions par défaut', 'defaultTerms', 'Reprises sur chaque nouvelle soumission détaillée. Tu peux les modifier au cas par cas.'),
  fieldWrap('Modalités de paiement', 'paymentInstructions', 'Affichées sur tes factures et dans les messages d’envoi.'),
  fieldWrap('Délai de paiement des factures (jours)', 'invoiceDueDays'),
  h('div', { class: 'form-row' },
    fieldWrap('Acompte à la signature (%)', 'depositPct', 'Facture d’acompte créée dès que le client accepte ou signe. Vide = aucun.'),
    fieldWrap('Plancher de marge (%)', 'marginFloorPct', 'La marge passe au rouge sous ce seuil. Privé.')),
  h('div', { class: 'btn-row save-row' },
    h('button', { class: 'btn btn-ink btn-sm', type: 'submit' }, 'Enregistrer le profil'),
    savedNote));

  const pw = h('input', { class: 'input', type: 'password', id: 'acct-delete-pw', autocomplete: 'current-password' });
  body.replaceChildren(
    section('Profil et entreprise', h('p', {}, 'Ces informations signent tes messages et apparaissent sur les soumissions que tu envoies.'), profileForm),
    section('Bibliothèque',
      h('p', {}, `${plural((state.catalog || []).filter((c) => c.kind === 'item').length, 'article', 'articles')}, ${plural((state.catalog || []).filter((c) => c.kind === 'package').length, 'forfait', 'forfaits')}. Tes prix, tes coûts et tes forfaits, en un toucher dans chaque soumission.`),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-ink btn-sm', type: 'button', onClick: () => { $('accountDialog').close(); catalogUI.open({ manage: true }); } }, 'Gérer ma bibliothèque'))),
    billingSection(),
    dataSection,
    section('Session',
      h('p', {}, `Connecté avec ${u.email}.`),
      h('div', { class: 'btn-row' }, h('button', {
        class: 'btn btn-ghost on-paper btn-sm', type: 'button',
        onClick: async () => {
          try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch { /* on sort quand même */ }
          await clearOfflineData();
          location.href = '/';
        },
      }, 'Se déconnecter'))),
    section('Supprimer mon compte',
      h('p', {}, 'Efface ton compte et toutes tes soumissions, et arrête ton abonnement. Exporte tes données avant : c’est définitif.'),
      h('div', { class: 'field' }, h('label', { for: 'acct-delete-pw' }, 'Ton mot de passe'), pw),
      h('div', { class: 'btn-row' }, h('button', {
        class: 'btn btn-danger btn-sm', type: 'button',
        onClick: async () => {
          if (!pw.value) { toast('Entre ton mot de passe pour confirmer.', { error: true }); return; }
          if (!confirm('Supprimer définitivement ton compte et toutes tes soumissions?')) return;
          try {
            await api('/api/me', { method: 'DELETE', body: { password: pw.value } });
            await clearOfflineData();
            location.href = '/?compte=supprime';
          } catch (e) { handleError(e); }
        },
      }, 'Supprimer mon compte'))));
  if (!$('accountDialog').open) $('accountDialog').showModal();
}

// =============== Branchements ===============
function wireStatic() {
  // Fermeture des dialogues : bouton, clic sur le fond.
  document.querySelectorAll('dialog').forEach((dlg) => {
    dlg.addEventListener('click', (ev) => {
      if (ev.target === dlg || ev.target.closest('[data-close]')) dlg.close();
    });
  });

  $('newBtn').addEventListener('click', () => { if (requireWrite()) openQuote(); });
  $('accountBtn').addEventListener('click', () => { if (state.store) openAccount(); });
  document.querySelectorAll('[data-account]').forEach((b) => b.addEventListener('click', () => { if (state.store) openAccount(); }));

  $('search').addEventListener('input', (ev) => { state.search = ev.target.value; renderLists(); });
  $('filters').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-filter]');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    $('filters').querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    renderLists();
  });

  const form = $('quoteForm');
  form.addEventListener('submit', saveQuote);
  form.elements.sentOn.addEventListener('change', () => {
    if (!state.followUpTouched && form.elements.sentOn.value) form.elements.followUpOn.value = addDays(form.elements.sentOn.value, 3);
  });
  form.elements.followUpOn.addEventListener('input', () => { state.followUpTouched = true; });
  form.elements.status.addEventListener('change', updateFollowHint);
  $('deleteQuote').addEventListener('click', deleteQuote);
  $('detailToggle').addEventListener('click', () => setDetailed(!state.detailed, { seedFromAmount: true }));
  quoteLines = createLineEditor({
    listEl: $('lines'), totalsEl: $('totals'), discountInput: form.elements.discount, taxesInput: form.elements.taxes,
    idPrefix: 'line', isWritable: canWrite, allowOptional: true, allowCost: true, showCost: () => state.showCosts,
    marginEl: $('marginBar'),
    marginFloor: () => (state.me && state.me.user && state.me.user.business ? state.me.user.business.marginFloorPct : null),
  });
  $('addLine').addEventListener('click', () => quoteLines.add());
  $('openCatalog').addEventListener('click', () => { if (requireWrite()) catalogUI.open(); });
  $('savePackage').addEventListener('click', () => catalogUI.saveAsPackage(quoteLines.snapshot()));
  $('showCosts').addEventListener('change', (ev) => {
    state.showCosts = ev.target.checked;
    localStorageFlag('sp_show_costs', state.showCosts ? '1' : '0');
    quoteLines.render();
    quoteLines.update();
  });
  $('duplicateQuote').addEventListener('click', () => {
    const id = state.editingId;
    $('quoteDialog').close();
    if (requireWrite()) openQuote(null, { duplicateOf: id });
  });
  $('signHere').addEventListener('click', () => {
    const q = state.quotes.find((x) => x.id === state.editingId);
    $('quoteDialog').close();
    signUI.open(q);
  });
  $('makeDeposit').addEventListener('click', async () => {
    const id = state.editingId;
    const existing = invoicesUI.depositFor(id);
    $('quoteDialog').close();
    if (existing) { setView('invoices'); invoicesUI.open(existing.id); return; }
    const pctProfile = state.me && state.me.user.business ? state.me.user.business.depositPct : 0;
    let pct = null;
    if (!pctProfile) {
      const raw = prompt('Pourcentage d’acompte (ex. 30) :', '30');
      if (!raw) return;
      pct = Number(String(raw).replace(/[\s%]/g, ''));
    }
    const inv = await invoicesUI.createDeposit(id, pct);
    if (inv) setView('invoices');
  });
  catalogUI.wire();
  $('quickLines').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-line]');
    if (btn && canWrite()) quoteLines.add({ description: btn.dataset.line, unit: btn.dataset.unit || '' });
  });
  $('sendDone').addEventListener('click', sendDone);
  $('reminderDone').addEventListener('click', reminderDone);
  $('makeInvoice').addEventListener('click', () => {
    const id = state.editingId;
    const existing = invoicesUI.invoiceFor(id);
    $('quoteDialog').close();
    if (existing) { setView('invoices'); invoicesUI.open(existing.id); } else invoicesUI.createFromQuote(id).then(() => setView('invoices'));
  });
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  invoicesUI.wire();
  document.addEventListener('visibilitychange', refreshQuotes);

  document.querySelectorAll('[data-channel]').forEach((b) => b.addEventListener('click', () => {
    state.channel = b.dataset.channel;
    renderFollowMessage();
  }));
  $('followMessage').addEventListener('input', updateSendLinks);
  $('copyMsg').addEventListener('click', async () => {
    const ok = await copyText($('followMessage').value);
    toast(ok ? 'Message copié. Colle-le dans ton courriel ou tes textos.' : 'Copie impossible : sélectionne le texte et copie-le.', { error: !ok });
  });
  $('markDone').addEventListener('click', markFollowDone);

  $('importFile').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    await importFile(file);
  });
}

const invoicesUI = createInvoicesUI({
  state, api, $, isDemo, canWrite, requireWrite, handleError, openMessage,
  rerender: () => render(),
});

const catalogUI = createCatalogUI({
  state, api, $, isDemo, canWrite, requireWrite, handleError,
  onPick: (lines) => {
    if (!state.detailed) setDetailed(true);
    quoteLines.addMany(lines);
  },
});

const signUI = createSignUI({
  state, api, $, requireWrite, handleError,
  afterSigned: async () => {
    try {
      await reload();
      await invoicesUI.load();
    } catch { /* on garde l'affichage */ }
    render();
  },
  openInvoice: (id) => { setView('invoices'); invoicesUI.open(id); },
  sendCopy: (id) => shareAndSend(id),
  queueOffline: (id, body) => {
    if (!outbox) return false;
    outbox.queueSign(id, body);
    reload().then(render);
    return true;
  },
});

boot();
