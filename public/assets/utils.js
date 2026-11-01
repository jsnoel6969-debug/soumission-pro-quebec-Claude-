// Outils partagés (dates locales, argent, DOM sécuritaire, export/import).
import { toCents, toQtyMilli, computeTotals } from './money.js';

const pad = (n) => String(n).padStart(2, '0');
export const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayISO = () => toISO(new Date());
export function parseISO(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}
export function daysBetween(fromIso, toIso) {
  return Math.round((parseISO(toIso) - parseISO(fromIso)) / 86_400_000);
}
export function isValidISO(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parseISO(s);
  return toISO(d) === s;
}

const fmtMoney0 = new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });
const fmtMoney2 = new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money = (n) => (Math.round(n * 100) % 100 === 0 ? fmtMoney0.format(Math.round(n)) : fmtMoney2.format(n));
export const moneyRound = (n) => fmtMoney0.format(Math.round(n));
export const money2 = (n) => fmtMoney2.format(n);

/** Horodatage (ms) → « il y a 3 h ». */
export function relTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'à l’instant';
  if (min < 60) return `il y a ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `il y a ${days} j`;
  return `le ${dateLong(toISO(new Date(ms)))}`;
}

const fmtDay = new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'long' });
const fmtDayYear = new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'long', year: 'numeric' });
export function dateLong(iso) {
  if (!iso) return '';
  const d = parseISO(iso);
  return d.getFullYear() === new Date().getFullYear() ? fmtDay.format(d) : fmtDayYear.format(d);
}
export function relDays(n) {
  if (n === 0) return "aujourd'hui";
  if (n === 1) return 'demain';
  if (n === -1) return 'hier';
  return n > 0 ? `dans ${n} jours` : `il y a ${-n} jours`;
}
export const ordinal = (n) => (n === 1 ? '1re' : `${n}e`);

export const STATUS_LABEL = { pending: 'En attente', accepted: 'Acceptée', refused: 'Refusée' };

export function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Constructeur DOM : jamais d'innerHTML avec des données utilisateur. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

let toastTimer = null;
export function toast(message, { error = false } = {}) {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.toggle('is-error', error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, error ? 6000 : 3500);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { class: 'sr-only', 'aria-hidden': 'true' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

export function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------- Export ----------
function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // anti-injection de formules Excel
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(quotes) {
  const head = ['Numéro', 'Client', 'Projet', 'Montant', 'TPS', 'TVQ', 'Statut', 'Envoyée le', 'Valide jusqu’au', 'Prochaine relance',
    'Relances faites', 'Dernière relance', 'Ouvertures du lien', 'Courriel', 'Téléphone', 'Adresse des travaux', 'Notes'];
  const dec = (n) => Number(n || 0).toFixed(2).replace('.', ',');
  const rows = quotes.map((q) => [
    q.number || '', q.client, q.project, dec(q.amount), q.taxes ? dec(q.gst) : '', q.taxes ? dec(q.qst) : '',
    (q.decidedOnlineAt ? `${STATUS_LABEL[q.status]} en ligne` : STATUS_LABEL[q.status]) || q.status,
    q.sentOn, q.validUntil || '', q.followUpOn || '', q.followUpCount || 0, q.lastFollowUpOn || '', q.viewCount || 0,
    q.clientEmail || '', q.clientPhone || '', q.clientAddress || '', q.notes || '',
  ]);
  // BOM + point-virgule : s'ouvre proprement dans Excel en français.
  return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n');
}
export const PAYMENT_LABEL = { interac: 'Virement Interac', cheque: 'Chèque', cash: 'Comptant', card: 'Carte', other: 'Autre' };
export const INVOICE_STATUS_LABEL = { unpaid: 'À payer', paid: 'Payée', void: 'Annulée' };

/** Export comptable des factures (pour ton CPA). */
export function toInvoicesCsv(invoices) {
  const head = ['Numéro', 'Date', 'Échéance', 'Client', 'Projet', 'Sous-total', 'Rabais', 'TPS', 'TVQ', 'Total', 'Statut', 'Payée le', 'Mode de paiement'];
  const dec = (n) => Number(n || 0).toFixed(2).replace('.', ',');
  const rows = invoices.map((i) => [
    i.number, i.issuedOn, i.dueOn, i.client, i.project, dec(i.subtotal), dec(i.discount), dec(i.gst), dec(i.qst), dec(i.total),
    INVOICE_STATUS_LABEL[i.status] || i.status, i.paidOn || '', i.paymentMethod ? PAYMENT_LABEL[i.paymentMethod] : '',
  ]);
  return '\uFEFF' + [head, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n');
}

export function toJsonExport(quotes) {
  return JSON.stringify({
    app: 'soumission-pro', version: 2, exportedAt: new Date().toISOString(),
    quotes: quotes.map(({ id, createdAt, updatedAt, example, shareToken, sharedAt, firstViewedAt, lastViewedAt, ...rest }) => rest),
  }, null, 2);
}

// ---------- Import tolérant (exports, anciennes versions de la démo) ----------
const KEYS = {
  client: ['client', 'clientName', 'client_name', 'nomClient', 'nom_client', 'nom', 'name', 'customer'],
  project: ['project', 'projet', 'titre', 'title', 'travaux', 'description'],
  amount: ['amount', 'montant', 'total', 'valeur', 'value', 'prix', 'price'],
  status: ['status', 'statut', 'etat', 'état'],
  sentOn: ['sentOn', 'sent_on', 'dateEnvoi', 'date_envoi', 'envoyee', 'envoyéeLe', 'sentAt', 'date', 'createdAt'],
  followUpOn: ['followUpOn', 'follow_up_on', 'prochaineRelance', 'prochaine_relance', 'relance', 'dateRelance', 'followUp', 'nextFollowUp'],
  clientEmail: ['clientEmail', 'client_email', 'email', 'courriel'],
  clientPhone: ['clientPhone', 'client_phone', 'phone', 'telephone', 'téléphone', 'tel'],
  notes: ['notes', 'note', 'commentaire', 'commentaires'],
  followUpCount: ['followUpCount', 'follow_up_count', 'relances', 'nbRelances'],
  lastFollowUpOn: ['lastFollowUpOn', 'last_follow_up_on', 'derniereRelance'],
};
function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}
function toDate(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : toISO(d);
}
function toStatus(v) {
  const s = fold(v);
  if (s.includes('accept') || s.includes('sign') || s.includes('gagn')) return 'accepted';
  if (s.includes('refus') || s.includes('perd') || s.includes('lost')) return 'refused';
  return 'pending';
}
function looksLikeQuote(o) {
  return o && typeof o === 'object' && !Array.isArray(o)
    && pick(o, KEYS.client) !== undefined && pick(o, KEYS.amount) !== undefined;
}
function findArray(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    if (Array.isArray(data.quotes)) return data.quotes;
    for (const v of Object.values(data)) if (Array.isArray(v) && v.some(looksLikeQuote)) return v;
  }
  return [];
}
export function normalizeImported(data, { includeExamples = false } = {}) {
  return findArray(data)
    .filter(looksLikeQuote)
    .filter((o) => includeExamples || !o.example)
    .map((o) => {
      const amountRaw = pick(o, KEYS.amount);
      const amountCents = pick(o, ['amount_cents', 'amountCents']);
      return {
        client: String(pick(o, KEYS.client) ?? '').trim(),
        project: String(pick(o, KEYS.project) ?? 'Projet').trim() || 'Projet',
        amount: amountCents !== undefined ? Number(amountCents) / 100 : amountRaw,
        status: toStatus(pick(o, KEYS.status)),
        sentOn: toDate(pick(o, KEYS.sentOn)) || todayISO(),
        followUpOn: toDate(pick(o, KEYS.followUpOn)),
        clientEmail: String(pick(o, KEYS.clientEmail) ?? ''),
        clientPhone: String(pick(o, KEYS.clientPhone) ?? ''),
        notes: String(pick(o, KEYS.notes) ?? ''),
        followUpCount: Number.parseInt(pick(o, KEYS.followUpCount), 10) || 0,
        lastFollowUpOn: toDate(pick(o, KEYS.lastFollowUpOn)),
        number: typeof o.number === 'string' ? o.number : '',
        items: Array.isArray(o.items) ? o.items : [],
        discount: o.discount ?? '',
        taxes: o.taxes === true,
        validUntil: toDate(o.validUntil),
        clientAddress: typeof o.clientAddress === 'string' ? o.clientAddress : '',
        terms: typeof o.terms === 'string' ? o.terms : '',
      };
    });
}

/** Cherche, dans ce navigateur, des soumissions laissées par la démo (actuelle ou ancienne version). */
export function detectLocalQuotes(ignoreKeys = []) {
  const found = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || ignoreKeys.includes(key)) continue;
      let data;
      try { data = JSON.parse(localStorage.getItem(key)); } catch { continue; }
      const quotes = normalizeImported(data).filter((q) => q.client);
      if (quotes.length) found.push(...quotes);
    }
  } catch { /* stockage indisponible */ }
  return found;
}

/** Validation côté client (miroir du serveur) pour des messages immédiats. */
export function validateQuote(q) {
  if (!q.client || !q.client.trim()) return { field: 'client', message: 'Le nom du client est requis.' };
  if (q.client.length > 120) return { field: 'client', message: '120 caractères maximum.' };
  if (!q.project || !q.project.trim()) return { field: 'project', message: 'Le projet est requis.' };
  if (q.project.length > 160) return { field: 'project', message: '160 caractères maximum.' };
  if (Array.isArray(q.items) && q.items.length) {
    const lines = [];
    for (let i = 0; i < q.items.length; i++) {
      const it = q.items[i];
      const n = i + 1;
      if (!String(it.description ?? '').trim()) return { field: `items.${i}.description`, message: `Ligne ${n} : la description est requise.` };
      if (String(it.description).length > 250) return { field: `items.${i}.description`, message: '250 caractères maximum.' };
      const qtyMilli = toQtyMilli(it.qty);
      if (qtyMilli === null) return { field: `items.${i}.qty`, message: `Ligne ${n} : quantité invalide.` };
      const unitCents = toCents(it.unitPrice);
      if (unitCents === null) return { field: `items.${i}.unitPrice`, message: `Ligne ${n} : prix invalide.` };
      lines.push({ qtyMilli, unitCents });
    }
    const discount = q.discount === '' || q.discount === null || q.discount === undefined ? 0 : toCents(q.discount);
    if (discount === null) return { field: 'discount', message: 'Rabais invalide.' };
    const t = computeTotals(lines, discount, q.taxes === true);
    if (t.error === 'discount') return { field: 'discount', message: 'Le rabais dépasse le sous-total.' };
    if (t.error) return { field: null, message: 'Total trop élevé.' };
  } else if (parseAmount(q.amount) === null) {
    return { field: 'amount', message: 'Montant invalide.' };
  }
  if (!isValidISO(q.sentOn)) return { field: 'sentOn', message: "La date d'envoi est requise." };
  if (q.followUpOn && !isValidISO(q.followUpOn)) return { field: 'followUpOn', message: 'Date de relance invalide.' };
  if (q.clientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(q.clientEmail.trim())) return { field: 'clientEmail', message: 'Courriel invalide.' };
  if (q.notes && q.notes.length > 2000) return { field: 'notes', message: '2000 caractères maximum.' };
  if (q.validUntil && !isValidISO(q.validUntil)) return { field: 'validUntil', message: 'Date de validité invalide.' };
  if (q.terms && q.terms.length > 4000) return { field: 'terms', message: '4000 caractères maximum.' };
  return null;
}
export function parseAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v <= 100_000_000 ? v : null;
  const s = String(v ?? '').replace(/[\s  $]/g, '').replace(/,(?=\d{1,2}$)/, '.').replace(/,/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 100_000_000 ? Math.round(n * 100) / 100 : null;
}
