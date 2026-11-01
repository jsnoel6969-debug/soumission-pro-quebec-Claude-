import { api, ApiStore, LocalStore } from './store.js';
import {
  h, toast, todayISO, addDays, daysBetween, dateLong, relDays, relTime, money, money2, moneyRound, fold, ordinal,
  copyText, download, toCsv, toJsonExport, normalizeImported, detectLocalQuotes, validateQuote,
} from './utils.js';
import { toCents, toQtyMilli, computeTotals, lineCents } from './money.js';
import { buildMessage, mailtoHref, smsHref, suggestedNextDays } from './templates.js';

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
  followId: null,
  channel: 'email',
  detailed: false,
  lines: [],
  sendMode: false,
  announcements: [],
  lastRefresh: 0,
};

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
  }
  try {
    await reload();
  } catch (err) {
    $('loading').textContent = err.message;
    return;
  }
  $('loading').hidden = true;
  $('content').hidden = false;
  $('newBtn').hidden = false;
  announceDecisions();
  render();
  handleReturnParams();
}

function localStorageFlag(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* stockage indisponible */ }
  return null;
}

async function reload() {
  state.quotes = await state.store.list();
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
  if (q.status === 'accepted') return h('span', { class: 'tag tag-go', text: q.decidedOnlineAt ? 'Acceptée en ligne' : 'Acceptée' });
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
function render() {
  renderPlan();
  renderBanners();
  renderStats();
  renderLists();
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
      h('button', { class: 'btn btn-ink btn-sm', type: 'button', onClick: () => { dismiss(); openQuote(q.id); } }, 'Voir la soumission'),
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
  // Les soumissions ouvertes récemment passent devant : c'est le meilleur moment pour appeler.
  const due = state.quotes.filter((q) => isDue(q, today))
    .sort((a, b) => (Number(isHot(b)) - Number(isHot(a)))
      || (a.followUpOn < b.followUpOn ? -1 : a.followUpOn > b.followUpOn ? 1 : b.amount - a.amount));
  $('dueCount').textContent = due.length ? String(due.length) : '';

  if (due.length) {
    $('dueList').replaceChildren(...due.map((q) => slip(q, today, { due: true })));
  } else if (!state.quotes.length) {
    $('dueList').replaceChildren(h('div', { class: 'empty' },
      h('strong', {}, 'Aucune soumission pour l’instant.'),
      'Ajoute la dernière soumission que tu as envoyée : la relance se planifie toute seule, 3 jours plus tard.',
      h('div', {}, h('button', { class: 'btn btn-ink', type: 'button', onClick: () => openQuote() }, 'Ajouter une soumission'))));
  } else {
    const next = state.quotes.filter((q) => q.status === 'pending' && q.followUpOn && q.followUpOn > today)
      .sort((a, b) => (a.followUpOn < b.followUpOn ? -1 : 1))[0];
    $('dueList').replaceChildren(h('div', { class: 'empty' },
      h('strong', {}, 'Rien à relancer aujourd’hui.'),
      next ? `Prochaine relance : ${next.client}, ${relDays(daysBetween(today, next.followUpOn))}.` : 'Aucune relance planifiée.'));
  }

  const needle = fold(state.search.trim());
  const filtered = state.quotes.filter((q) =>
    (state.filter === 'all' || q.status === state.filter)
    && (!needle || fold(`${q.client} ${q.project} ${q.notes || ''}`).includes(needle)));
  $('allCount').textContent = String(filtered.length);
  $('allList').replaceChildren(...(filtered.length
    ? filtered.map((q) => slip(q, today))
    : [h('div', { class: 'empty' }, state.quotes.length ? 'Aucune soumission ne correspond à ta recherche.' : 'Tes soumissions apparaîtront ici.')]));
}

// =============== Soumission (ajout / modification) ===============
const FIELDS = ['client', 'project', 'amount', 'status', 'sentOn', 'followUpOn', 'clientEmail', 'clientPhone', 'notes',
  'discount', 'validUntil', 'clientAddress', 'terms'];
const DETAIL_ONLY = ['discount', 'validUntil', 'clientAddress', 'terms'];

const decimalText = (n) => (n === null || n === undefined || n === '' ? '' : String(n).replace('.', ','));
const emptyLine = () => ({ description: '', qty: '1', unit: '', unitPrice: '' });
const lineIsBlank = (l) => !String(l.description).trim() && !String(l.unitPrice).trim() && (!String(l.qty).trim() || String(l.qty).trim() === '1');

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

function setDetailed(on, { seedFromAmount = false } = {}) {
  const form = $('quoteForm');
  if (on && seedFromAmount && !state.lines.length) {
    const amount = form.elements.amount.value.trim();
    state.lines = [amount
      ? { description: form.elements.project.value.trim() || 'Travaux', qty: '1', unit: 'forfait', unitPrice: amount }
      : emptyLine()];
  }
  if (!on && state.detailed) {
    // Retour au montant simple : le total calculé devient le montant.
    const t = currentTotals();
    if (t && !t.error && t.totalCents) form.elements.amount.value = decimalText((t.totalCents / 100).toFixed(2));
  }
  state.detailed = on;
  if (on && !state.lines.length) state.lines = [emptyLine()];
  $('detailBox').hidden = !on;
  $('detailHint').hidden = on;
  $('detailToggle').setAttribute('aria-expanded', String(on));
  $('detailToggle').textContent = on ? 'Revenir à un montant simple' : 'Détailler avec lignes et TPS/TVQ';
  form.querySelector('[data-field="amount"]').hidden = on;
  renderLines();
  updateTotals();
}

function renderLines() {
  const writable = canWrite();
  $('lines').replaceChildren(...state.lines.map((line, i) => {
    const n = i + 1;
    const input = (key, attrs = {}) => {
      const el = h('input', { class: `input ${attrs.num ? 'num' : ''}`, id: `line-${key}-${i}`, autocomplete: 'off',
        inputmode: attrs.num ? 'decimal' : null, placeholder: attrs.placeholder || null, maxlength: attrs.max || null, disabled: !writable });
      el.value = line[key] ?? '';
      el.addEventListener('input', () => { line[key] = el.value; updateTotals(); });
      return el;
    };
    return h('div', { class: 'line' },
      h('div', { class: 'field line-desc' },
        h('label', { for: `line-description-${i}` }, `Ligne ${n}`),
        input('description', { placeholder: 'Description des travaux ou du matériel', max: '250' })),
      h('div', { class: 'line-nums' },
        h('div', { class: 'field' }, h('label', { for: `line-qty-${i}` }, 'Qté'), input('qty', { num: true })),
        h('div', { class: 'field' }, h('label', { for: `line-unit-${i}` }, 'Unité'), input('unit', { placeholder: 'h, pi²', max: '12' })),
        h('div', { class: 'field' }, h('label', { for: `line-unitPrice-${i}` }, 'Prix unitaire'), input('unitPrice', { num: true, placeholder: '0,00' })),
        h('div', { class: 'line-total' }, h('span', { class: 'label' }, 'Montant'), h('span', { class: 'num', id: `line-total-${i}` }, '—'))),
      writable && state.lines.length > 1
        ? h('button', { class: 'btn btn-quiet btn-sm line-remove', type: 'button', onClick: () => { state.lines.splice(i, 1); renderLines(); updateTotals(); } }, `Retirer la ligne ${n}`)
        : null);
  }));
}

function addLine(preset = {}) {
  const last = state.lines[state.lines.length - 1];
  const line = { ...emptyLine(), ...preset };
  if (last && lineIsBlank(last)) state.lines[state.lines.length - 1] = line;
  else state.lines.push(line);
  renderLines();
  updateTotals();
  const i = state.lines.length - 1;
  const focus = $(preset.description ? `line-unitPrice-${i}` : `line-description-${i}`);
  if (focus) focus.focus();
}

function currentTotals() {
  const form = $('quoteForm');
  const calc = state.lines.map((l) => ({ qtyMilli: toQtyMilli(l.qty) ?? 0, unitCents: toCents(l.unitPrice) ?? 0 }));
  const discountCents = toCents(form.elements.discount.value || '0') ?? 0;
  return { ...computeTotals(calc, discountCents, form.elements.taxes.checked), calc };
}

function updateTotals() {
  if (!state.detailed) return;
  const t = currentTotals();
  t.calc.forEach((l, i) => {
    const el = $(`line-total-${i}`);
    if (el) el.textContent = l.qtyMilli && l.unitCents ? money2(lineCents(l.qtyMilli, l.unitCents) / 100) : '—';
  });
  const row = (label, value, cls = '') => h('div', { class: `total-row ${cls}` }, h('dt', {}, label), h('dd', { class: 'num' }, value));
  const rows = [];
  if (t.error === 'discount') rows.push(h('div', { class: 'field-error' }, 'Le rabais dépasse le sous-total.'));
  else if (t.error) rows.push(h('div', { class: 'field-error' }, 'Total trop élevé.'));
  else {
    rows.push(row('Sous-total', money2(t.subtotalCents / 100)));
    if (t.discountCents) rows.push(row('Rabais', `− ${money2(t.discountCents / 100)}`));
    if ($('quoteForm').elements.taxes.checked) {
      rows.push(row('TPS (5 %)', money2(t.gstCents / 100)));
      rows.push(row('TVQ (9,975 %)', money2(t.qstCents / 100)));
    }
    rows.push(row('Total', money2(t.totalCents / 100), 'is-total'));
  }
  $('totals').replaceChildren(...rows);
}

function openQuote(id = null) {
  const form = $('quoteForm');
  clearErrors(form);
  const q = id ? state.quotes.find((x) => x.id === id) : null;
  state.editingId = q ? q.id : null;
  state.followUpTouched = Boolean(q);
  $('quoteTitle').textContent = q ? `Soumission${q.number ? ` n° ${q.number}` : ''}` : 'Nouvelle soumission';
  const today = todayISO();
  const defaults = businessDefaults();
  const values = q
    ? { ...q, amount: decimalText(q.amount), discount: q.discount ? decimalText(q.discount) : '' }
    : { client: '', project: '', amount: '', status: 'pending', sentOn: today, followUpOn: addDays(today, 3), clientEmail: '', clientPhone: '',
      notes: '', discount: '', validUntil: addDays(today, 30), clientAddress: '', terms: defaults.terms };
  if (q && !q.detailed && !q.validUntil) values.validUntil = addDays(q.sentOn || today, 30);
  if (q && !q.detailed && !q.terms) values.terms = defaults.terms;
  for (const f of FIELDS) form.elements[f].value = values[f] ?? '';
  form.elements.taxes.checked = q && q.detailed ? q.taxes : defaults.taxes;
  state.lines = q && q.detailed
    ? q.items.map((it) => ({ description: it.description, qty: decimalText(it.qty), unit: it.unit || '', unitPrice: decimalText(it.unitPrice) }))
    : [];
  state.detailed = false;
  setDetailed(Boolean(q && q.detailed));

  const writable = canWrite();
  for (const f of FIELDS) form.elements[f].disabled = !writable;
  form.elements.taxes.disabled = !writable;
  $('detailToggle').disabled = !writable;
  $('addLine').disabled = !writable;
  $('saveQuote').hidden = !writable;
  $('saveSend').hidden = !(writable && !isDemo() && (!q || q.status === 'pending'));
  $('deleteQuote').hidden = !(q && writable);
  if (!writable) {
    $('quoteError').textContent = 'Lecture seule : active ton abonnement pour modifier tes soumissions.';
    $('quoteError').hidden = false;
  }
  updateFollowHint();
  renderLinkBox(q);
  $('quoteDialog').showModal();
  if (!q && writable) form.elements.client.focus();
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
  if (state.detailed) {
    state.lines = state.lines.filter((l) => !lineIsBlank(l));
    renderLines();
    updateTotals();
    data.items = state.lines.map((l) => ({ description: l.description, qty: l.qty, unit: l.unit, unitPrice: l.unitPrice }));
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
    if (!state.lines.length) state.lines = [emptyLine()];
    renderLines();
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
  try {
    const wasEditing = Boolean(state.editingId);
    const saved = state.editingId ? await state.store.update(state.editingId, data) : await state.store.create(data);
    $('quoteDialog').close();
    await reload();
    render();
    if (sendAfter) await shareAndSend(saved.id);
    else toast(wasEditing ? 'Soumission mise à jour.' : 'Soumission ajoutée.');
  } catch (e) {
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

// =============== Relance et envoi ===============
const NEXT_OPTIONS = [[3, 'Dans 3 jours'], [7, 'Dans 7 jours'], [14, 'Dans 14 jours'], [0, 'Aucune']];

function signer() {
  if (isDemo() || !state.me) return {};
  const u = state.me.user;
  return { displayName: u.displayName, company: u.company, phone: u.business ? u.business.businessPhone : '' };
}

function openFollow(id, { send = false } = {}) {
  const q = state.quotes.find((x) => x.id === id);
  if (!q) return;
  state.followId = id;
  state.sendMode = send;
  state.channel = q.clientPhone && !q.clientEmail ? 'sms' : 'email';
  const count = q.followUpCount || 0;
  const ago = daysBetween(q.sentOn, todayISO());
  $('followTitle').textContent = send ? `Envoyer à ${q.client}` : `Relancer ${q.client}`;
  $('followContext').textContent = send
    ? `« ${q.project} », ${money2(q.amount)}. Ton client pourra la consulter et l’accepter en ligne.`
    : `« ${q.project} », ${money(q.amount)}. Envoyée ${relDays(-ago)}. Ce sera ta ${ordinal(count + 1)} relance.${q.viewCount ? ` Ouverte ${q.viewCount} fois, ${relTime(q.lastViewedAt)}.` : ''}`;
  const suggested = suggestedNextDays(count);
  $('nextChips').replaceChildren(...NEXT_OPTIONS.map(([days, label]) => h('label', {},
    h('input', { type: 'radio', name: 'nextDays', value: String(days), checked: days === suggested }),
    h('span', {}, label))));
  $('doneBox').hidden = send;
  $('sendDoneRow').hidden = !send;
  $('markDone').disabled = !canWrite();
  renderFollowMessage();
  $('followDialog').showModal();
}

function renderFollowMessage() {
  const q = state.quotes.find((x) => x.id === state.followId);
  if (!q) return;
  document.querySelectorAll('[data-channel]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.channel === state.channel)));
  const msg = buildMessage(q, { channel: state.channel, signer: signer(), link: linkUrl(q), kind: state.sendMode ? 'send' : 'follow' });
  $('followMessage').value = msg.body;
  $('followMessage').dataset.subject = msg.subject;
  updateSendLinks();
}

function updateSendLinks() {
  const q = state.quotes.find((x) => x.id === state.followId);
  if (!q) return;
  const body = $('followMessage').value;
  const mail = $('openMail');
  const sms = $('openSms');
  mail.hidden = !(state.channel === 'email' && q.clientEmail);
  sms.hidden = !(state.channel === 'sms' && q.clientPhone);
  if (!mail.hidden) mail.href = mailtoHref(q.clientEmail, $('followMessage').dataset.subject || '', body);
  if (!sms.hidden) sms.href = smsHref(q.clientPhone, body);
  const missing = state.channel === 'email' ? !q.clientEmail : !q.clientPhone;
  $('contactHint').hidden = !missing;
  $('contactHint').textContent = state.channel === 'email'
    ? 'Ajoute le courriel du client au dossier pour ouvrir le message directement dans ton application courriel.'
    : 'Ajoute le cellulaire du client au dossier pour ouvrir le texto directement.';
}

function sendDone() {
  const q = state.quotes.find((x) => x.id === state.followId);
  $('followDialog').close();
  toast(q && q.followUpOn ? `Parfait. Relance prévue le ${dateLong(q.followUpOn)}, sauf si ton client accepte avant.` : 'Parfait.');
}

async function markFollowDone() {
  if (!requireWrite()) return;
  const checked = document.querySelector('input[name="nextDays"]:checked');
  const days = checked ? Number(checked.value) : 0;
  const today = todayISO();
  const btn = $('markDone');
  btn.disabled = true;
  try {
    const q = await state.store.followUp(state.followId, { doneOn: today, nextFollowUpOn: days ? addDays(today, days) : null });
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
  const fresh = state.quotes.filter((q) => q.decidedOnlineAt && q.decidedOnlineAt > seen)
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
      h('button', { class: 'btn btn-ghost on-paper btn-sm', type: 'button', onClick: () => $('importFile').click() }, 'Importer un fichier JSON')));

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
  };
  const taxesBox = h('input', { type: 'checkbox', id: 'acct-taxes' });
  taxesBox.checked = biz.chargeTaxes !== false;
  const profileError = h('div', { class: 'alert alert-error', role: 'alert', hidden: true });
  const fieldWrap = (label, key, hint) => h('div', { class: 'field', dataset: { field: key } },
    h('label', { for: fields[key].id }, label), fields[key], hint ? h('span', { class: 'hint' }, hint) : null);
  const profileForm = h('form', {
    class: 'form-grid',
    onSubmit: async (ev) => {
      ev.preventDefault();
      profileError.hidden = true;
      profileForm.querySelectorAll('.field-error').forEach((el) => el.remove());
      const v = (k) => fields[k].value;
      try {
        state.me = await api('/api/me', { method: 'PATCH', body: {
          displayName: v('displayName'), company: v('company'),
          business: {
            businessPhone: v('businessPhone'), businessEmail: v('businessEmail'), businessAddress: v('businessAddress'),
            rbqNumber: v('rbqNumber'), gstNumber: v('gstNumber'), qstNumber: v('qstNumber'),
            chargeTaxes: taxesBox.checked, defaultTerms: v('defaultTerms'),
          },
        } });
        render();
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
  h('div', {}, h('button', { class: 'btn btn-ink btn-sm', type: 'submit' }, 'Enregistrer le profil')));

  const pw = h('input', { class: 'input', type: 'password', id: 'acct-delete-pw', autocomplete: 'current-password' });
  body.replaceChildren(
    section('Profil et entreprise', h('p', {}, 'Ces informations signent tes messages et apparaissent sur les soumissions que tu envoies.'), profileForm),
    billingSection(),
    dataSection,
    section('Session',
      h('p', {}, `Connecté avec ${u.email}.`),
      h('div', { class: 'btn-row' }, h('button', {
        class: 'btn btn-ghost on-paper btn-sm', type: 'button',
        onClick: async () => {
          try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch { /* on sort quand même */ }
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
  $('addLine').addEventListener('click', () => addLine());
  $('quickLines').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-line]');
    if (btn && canWrite()) addLine({ description: btn.dataset.line, unit: btn.dataset.unit || '' });
  });
  form.elements.discount.addEventListener('input', updateTotals);
  form.elements.taxes.addEventListener('change', updateTotals);
  $('sendDone').addEventListener('click', sendDone);
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

boot();
