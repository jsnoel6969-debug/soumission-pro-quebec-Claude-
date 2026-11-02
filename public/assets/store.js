// Deux magasins, même interface : ApiStore (compte synchronisé) et LocalStore (démo sur l'appareil).
import { addDays, todayISO, parseAmount, validateQuote } from './utils.js';
import { toCents, toQtyMilli, computeTotals } from './money.js';

export class ApiError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', 'Pas de connexion. Vérifie ton réseau et réessaie.');
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const e = (data && data.error) || {};
    throw new ApiError(res.status, e.code || 'error', e.message || 'Erreur inattendue. Réessaie.', e.field);
  }
  return data;
}

export class ApiStore {
  constructor() { this.mode = 'cloud'; }
  async list() { return (await api('/api/quotes')).quotes; }
  async create(q) { return (await api('/api/quotes', { method: 'POST', body: q })).quote; }
  async update(id, q) { return (await api(`/api/quotes/${id}`, { method: 'PUT', body: q })).quote; }
  async remove(id) { await api(`/api/quotes/${id}`, { method: 'DELETE' }); }
  async followUp(id, payload) { return (await api(`/api/quotes/${id}/follow-up`, { method: 'POST', body: payload })).quote; }
  async importMany(quotes) { return api('/api/quotes/import', { method: 'POST', body: { quotes } }); }
  async share(id) { return (await api(`/api/quotes/${id}/share`, { method: 'POST', body: {} })).quote; }
  async unshare(id) { return (await api(`/api/quotes/${id}/share`, { method: 'DELETE' })).quote; }
}

export const DEMO_KEY = 'sp_demo_v2';

const EMPTY_EXTRAS = {
  number: '', detailed: false, items: [], subtotal: null, discount: 0, taxes: false, gst: 0, qst: 0,
  validUntil: null, clientAddress: '', terms: '', shareToken: null, sharedAt: null, viewCount: 0,
  firstViewedAt: null, lastViewedAt: null, decidedOnlineAt: null, decidedByName: '', clientMessage: '',
};

function seedExamples() {
  const t = todayISO();
  const now = Date.now();
  const year = t.slice(0, 4);
  const base = { ...EMPTY_EXTRAS, clientEmail: '', clientPhone: '', notes: '', lastFollowUpOn: null, example: true };
  const kitchen = moneyFields({
    items: [
      { description: 'Démolition et préparation', qty: '1', unit: 'forfait', unitPrice: '1200' },
      { description: 'Installation des armoires et du comptoir', qty: '1', unit: 'forfait', unitPrice: '4350' },
      { description: 'Main-d’œuvre de finition', qty: '24', unit: 'h', unitPrice: '60' },
      { description: 'Raccordements plomberie et électricité', qty: '1', unit: 'forfait', unitPrice: '550' },
    ],
    discount: '', taxes: true,
  });
  return [
    { ...base, ...kitchen, id: crypto.randomUUID(), number: `${year}-001`, client: 'Famille Tremblay (exemple)', project: 'Rénovation cuisine',
      status: 'pending', sentOn: addDays(t, -6), followUpOn: addDays(t, -1), validUntil: addDays(t, 24), followUpCount: 0,
      clientAddress: '45 av. des Pins, Laval', terms: 'Paiement : 30 % à la signature, solde à la fin des travaux.',
      sharedAt: now - 6 * 864e5, viewCount: 2, firstViewedAt: now - 5 * 864e5, lastViewedAt: now - 3 * 3600e3,
      createdAt: now, updatedAt: now },
    { ...base, id: crypto.randomUUID(), number: `${year}-002`, client: 'Marc Gagnon (exemple)', project: 'Terrasse arrière', amount: 5900,
      status: 'pending', sentOn: addDays(t, -2), followUpOn: addDays(t, 1), followUpCount: 0, createdAt: now - 1, updatedAt: now - 1 },
    { ...base, id: crypto.randomUUID(), number: `${year}-003`, client: 'Julie Roy (exemple)', project: 'Plancher salon', amount: 3200,
      status: 'accepted', sentOn: addDays(t, -12), followUpOn: null, followUpCount: 1, lastFollowUpOn: addDays(t, -8),
      decidedOnlineAt: now - 7 * 864e5, decidedByName: 'Julie Roy', createdAt: now - 2, updatedAt: now - 2 },
  ];
}

/** Même calcul que le serveur (money.js partagé). Suppose des données déjà validées. */
function moneyFields(q) {
  const items = Array.isArray(q.items) ? q.items : [];
  if (!items.length) {
    return { detailed: false, items: [], subtotal: null, discount: 0, taxes: false, gst: 0, qst: 0, amount: parseAmount(q.amount) };
  }
  const lines = items.map((it) => ({
    description: String(it.description).trim(), unit: String(it.unit || '').trim(),
    qtyMilli: toQtyMilli(it.qty), unitCents: toCents(it.unitPrice), optional: it.optional === true,
    costCents: it.unitCost === undefined || it.unitCost === null || String(it.unitCost).trim() === '' ? null : toCents(it.unitCost),
    itemId: it.itemId || null,
  }));
  const discountCents = q.discount === '' || q.discount === null || q.discount === undefined ? 0 : toCents(q.discount);
  const t = computeTotals(lines.map((l) => ({ ...l, excluded: l.optional })), discountCents, q.taxes === true);
  return {
    detailed: true,
    items: lines.map((l, i) => ({
      description: l.description, unit: l.unit, qty: l.qtyMilli / 1000, unitPrice: l.unitCents / 100, total: t.lineTotals[i] / 100, optional: l.optional,
      ...(Number.isInteger(l.costCents) ? { unitCost: l.costCents / 100 } : {}), ...(l.itemId ? { itemId: l.itemId } : {}),
    })),
    subtotal: t.subtotalCents / 100, discount: t.discountCents / 100, taxes: q.taxes === true,
    gst: t.gstCents / 100, qst: t.qstCents / 100, amount: t.totalCents / 100,
  };
}

function cleanLocal(q) {
  const err = validateQuote(q);
  if (err) throw new ApiError(400, 'validation_error', err.message, err.field);
  return {
    client: q.client.trim(),
    project: q.project.trim(),
    ...moneyFields(q),
    status: ['pending', 'accepted', 'refused'].includes(q.status) ? q.status : 'pending',
    sentOn: q.sentOn,
    followUpOn: q.followUpOn || null,
    validUntil: q.validUntil || null,
    clientEmail: (q.clientEmail || '').trim(),
    clientPhone: (q.clientPhone || '').trim(),
    clientAddress: (q.clientAddress || '').trim(),
    notes: (q.notes || '').trim(),
    terms: (q.terms || '').trim(),
    subcontract: q.subcontract === true,
    denouncedOn: q.denouncedOn || null,
  };
}

/** Aperçu local d'une soumission pas encore envoyée au serveur (brouillon hors ligne). */
export function previewQuote(data, { id, createdAt = Date.now() } = {}) {
  return { ...EMPTY_EXTRAS, ...cleanLocal(data), id, number: '', followUpCount: 0, lastFollowUpOn: null,
    subcontract: data.subcontract === true, denouncedOn: data.denouncedOn || null, createdAt, updatedAt: createdAt };
}

export class LocalStore {
  constructor() { this.mode = 'demo'; }
  _read() {
    try {
      const d = JSON.parse(localStorage.getItem(DEMO_KEY) || 'null');
      if (d && Array.isArray(d.quotes)) return d;
    } catch { /* données corrompues : on repart */ }
    return { quotes: [], seeded: false };
  }
  _write(d) {
    try { localStorage.setItem(DEMO_KEY, JSON.stringify(d)); } catch {
      throw new ApiError(0, 'storage', "Ce navigateur bloque l'enregistrement local (navigation privée?).");
    }
  }
  async list() {
    const d = this._read();
    if (!d.seeded) {
      d.quotes = seedExamples();
      d.seeded = true;
      this._write(d);
    }
    return [...d.quotes].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async create(q) {
    const d = this._read();
    const now = Date.now();
    d.nextNumber = (d.nextNumber || d.quotes.length + 1);
    const number = q.number || `${todayISO().slice(0, 4)}-${String(d.nextNumber++).padStart(3, '0')}`;
    const item = { ...EMPTY_EXTRAS, ...cleanLocal(q), number, id: crypto.randomUUID(), followUpCount: 0, lastFollowUpOn: null, createdAt: now, updatedAt: now };
    d.quotes.push(item);
    this._write(d);
    return item;
  }
  async update(id, q) {
    const d = this._read();
    const i = d.quotes.findIndex((x) => x.id === id);
    if (i < 0) throw new ApiError(404, 'not_found', 'Soumission introuvable.');
    d.quotes[i] = { ...d.quotes[i], ...cleanLocal(q), updatedAt: Date.now() };
    this._write(d);
    return d.quotes[i];
  }
  async remove(id) {
    const d = this._read();
    d.quotes = d.quotes.filter((x) => x.id !== id);
    this._write(d);
  }
  async followUp(id, { doneOn, nextFollowUpOn }) {
    const d = this._read();
    const q = d.quotes.find((x) => x.id === id);
    if (!q) throw new ApiError(404, 'not_found', 'Soumission introuvable.');
    q.followUpCount = (q.followUpCount || 0) + 1;
    q.lastFollowUpOn = doneOn;
    q.followUpOn = nextFollowUpOn || null;
    q.updatedAt = Date.now();
    this._write(d);
    return q;
  }
  async importMany(quotes) {
    let imported = 0;
    let skipped = 0;
    for (const raw of quotes) {
      try {
        const item = await this.create(raw);
        if (raw.followUpCount || raw.lastFollowUpOn) {
          const d = this._read();
          const q = d.quotes.find((x) => x.id === item.id);
          q.followUpCount = Math.max(0, Number.parseInt(raw.followUpCount, 10) || 0);
          q.lastFollowUpOn = raw.lastFollowUpOn || null;
          this._write(d);
        }
        imported++;
      } catch { skipped++; }
    }
    return { imported, skipped };
  }
  async share() {
    throw new ApiError(403, 'demo', 'Crée ton compte gratuit pour envoyer un lien que ton client accepte en ligne.');
  }
  async unshare(id) { return this._read().quotes.find((x) => x.id === id); }
  clear() { this._write({ quotes: [], seeded: true }); }
  realQuotes() { return this._read().quotes.filter((q) => !q.example); }
}
