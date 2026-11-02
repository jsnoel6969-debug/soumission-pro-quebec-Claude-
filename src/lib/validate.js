import { HttpError } from './http.js';
import { toCents, toQtyMilli, computeTotals, lineCents } from '../../public/assets/money.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[0-9+().\-\s#extEXT]{0,40}$/;
const STATUS_ALIASES = {
  pending: 'pending', 'en attente': 'pending', attente: 'pending',
  accepted: 'accepted', acceptee: 'accepted', 'acceptée': 'accepted', signee: 'accepted', 'signée': 'accepted',
  refused: 'refused', refusee: 'refused', 'refusée': 'refused', perdue: 'refused',
};

function bad(field, message) {
  return new HttpError(400, 'validation_error', message, { field });
}

const filled = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const UUID_RE = /^[0-9a-fA-F-]{36}$/;

export function str(value, field, { max, required = false, label = field }) {
  if (value === undefined || value === null) value = '';
  if (typeof value === 'number') value = String(value);
  if (typeof value !== 'string') throw bad(field, `${label} : valeur invalide.`);
  const v = value.replace(/\s+/g, ' ').trim();
  if (required && !v) throw bad(field, `${label} est requis.`);
  if (v.length > max) throw bad(field, `${label} : ${max} caractères maximum.`);
  return v;
}

export function multiline(value, field, { max, label }) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw bad(field, `${label} : valeur invalide.`);
  const v = value.replace(/\r\n/g, '\n').trim();
  if (v.length > max) throw bad(field, `${label} : ${max} caractères maximum.`);
  return v;
}

export function email(value, field = 'email', { required = true } = {}) {
  const v = str(value, field, { max: 254, required, label: 'Le courriel' }).toLowerCase();
  if (v && !EMAIL_RE.test(v)) throw bad(field, 'Courriel invalide.');
  return v;
}

export function password(value, field = 'password') {
  if (typeof value !== 'string' || value.length < 8) throw bad(field, 'Mot de passe : 8 caractères minimum.');
  if (value.length > 200) throw bad(field, 'Mot de passe trop long.');
  return value;
}

export function isoDate(value, field, { required = false, label = 'La date' } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw bad(field, `${label} est requise.`);
    return null;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw bad(field, `${label} est invalide.`);
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || y < 2000 || y > 2100) {
    throw bad(field, `${label} est invalide.`);
  }
  return value;
}

export function amountToCents(value, field = 'amount') {
  let n = value;
  if (typeof n === 'string') {
    const cleaned = n.replace(/[\s  $]/g, '').replace(/,(?=\d{1,2}$)/, '.').replace(/,/g, '');
    n = cleaned === '' ? NaN : Number(cleaned);
  }
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100_000_000) {
    throw bad(field, 'Montant invalide.');
  }
  return Math.round(n * 100);
}

export function status(value, field = 'status') {
  if (value === undefined || value === null || value === '') return 'pending';
  const key = String(value).trim().toLowerCase();
  const v = STATUS_ALIASES[key];
  if (!v) throw bad(field, 'Statut invalide.');
  return v;
}

/**
 * Lignes détaillées. Lignes entièrement vides ignorées. Aucune ligne = montant simple (null).
 * costCents (coût privé) et itemId (article de la bibliothèque) restent dans items_json : jamais montrés au client.
 */
export function cleanItems(raw, { max = 100 } = {}) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) throw bad('items', 'Lignes invalides.');
  const rows = raw.filter((r) => r && typeof r === 'object' && (filled(r.description) || filled(r.qty) || filled(r.unitPrice)));
  if (rows.length === 0) return null;
  if (rows.length > max) throw bad('items', `${max} lignes maximum.`);
  return rows.map((r, i) => {
    const n = i + 1;
    const description = multiline(r.description, `items.${i}.description`, { max: 250, label: `Ligne ${n} : la description` });
    if (!description) throw bad(`items.${i}.description`, `Ligne ${n} : la description est requise.`);
    const qtyMilli = toQtyMilli(r.qty);
    if (qtyMilli === null) throw bad(`items.${i}.qty`, `Ligne ${n} : quantité invalide.`);
    const unitCents = toCents(r.unitPrice);
    if (unitCents === null) throw bad(`items.${i}.unitPrice`, `Ligne ${n} : prix invalide.`);
    const unit = str(r.unit, `items.${i}.unit`, { max: 12, label: `Ligne ${n} : l'unité` });
    const line = { description, unit, qtyMilli, unitCents, optional: r.optional === true };
    if (filled(r.unitCost)) {
      const costCents = toCents(r.unitCost);
      if (costCents === null) throw bad(`items.${i}.unitCost`, `Ligne ${n} : coût invalide.`);
      line.costCents = costCents;
    }
    if (typeof r.itemId === 'string' && UUID_RE.test(r.itemId)) line.itemId = r.itemId;
    return line;
  });
}

function moneyFields(input) {
  const items = cleanItems(input.items);
  if (!items) {
    return {
      items_json: null, amount_cents: amountToCents(input.amount, 'amount'), subtotal_cents: null,
      discount_cents: 0, taxes: 0, gst_cents: 0, qst_cents: 0,
    };
  }
  return detailedMoney(items, input);
}

/**
 * Lignes validées + rabais + taxes → champs d'argent en cents (même calcul partout).
 * deductionCents : acompte déjà facturé, déduit avant taxes comme le rabais (facture finale).
 */
function detailedMoney(items, input, { deductionCents = 0 } = {}) {
  const discountRaw = input.discount;
  const discount = discountRaw === undefined || discountRaw === null || discountRaw === '' ? 0 : toCents(discountRaw);
  if (discount === null) throw bad('discount', 'Rabais invalide.');
  const taxes = input.taxes === true;
  if (items.every((it) => it.optional)) throw bad('items', 'Garde au moins une ligne incluse : les options s’ajoutent au prix de base.');
  // Les options ne comptent pas dans le prix de base : le client les ajoute lui-même.
  const t = computeTotals(items.map((it) => ({ ...it, excluded: it.optional })), discount + deductionCents, taxes);
  if (t.error === 'discount') {
    throw bad('discount', deductionCents ? 'Le rabais et l’acompte déjà facturé dépassent le sous-total.' : 'Le rabais dépasse le sous-total.');
  }
  if (t.error) throw bad('items', 'Total trop élevé.');
  return {
    items_json: JSON.stringify(items.map((it, i) => ({ ...it, lineCents: t.lineTotals[i] }))),
    amount_cents: t.totalCents,
    subtotal_cents: t.subtotalCents,
    discount_cents: discount,
    taxes: taxes ? 1 : 0,
    gst_cents: t.gstCents,
    qst_cents: t.qstCents,
  };
}

/** Normalise une soumission reçue du client. */
export function cleanQuote(input) {
  if (!input || typeof input !== 'object') throw bad('quote', 'Soumission invalide.');
  const clientEmail = email(input.clientEmail ?? input.client_email, 'clientEmail', { required: false });
  const phone = str(input.clientPhone ?? input.client_phone, 'clientPhone', { max: 40, label: 'Le téléphone' });
  if (phone && !PHONE_RE.test(phone)) throw bad('clientPhone', 'Téléphone invalide.');
  return {
    client: str(input.client, 'client', { max: 120, required: true, label: 'Le nom du client' }),
    project: str(input.project, 'project', { max: 160, required: true, label: 'Le projet' }),
    ...moneyFields(input),
    status: status(input.status),
    sent_on: isoDate(input.sentOn ?? input.sent_on, 'sentOn', { required: true, label: "La date d'envoi" }),
    follow_up_on: isoDate(input.followUpOn ?? input.follow_up_on, 'followUpOn', { label: 'La date de relance' }),
    valid_until: isoDate(input.validUntil ?? input.valid_until, 'validUntil', { label: 'La date de validité' }),
    client_email: clientEmail || null,
    client_phone: phone || null,
    client_address: str(input.clientAddress ?? input.client_address, 'clientAddress', { max: 200, label: "L'adresse" }) || null,
    notes: multiline(input.notes, 'notes', { max: 2000, label: 'Les notes' }) || null,
    terms: multiline(input.terms, 'terms', { max: 4000, label: 'Les conditions' }) || null,
    subcontract: input.subcontract === true ? 1 : 0,
    denounced_on: isoDate(input.denouncedOn ?? input.denounced_on, 'denouncedOn', { label: 'La date de dénonciation' }),
  };
}

/** Profil d'entreprise affiché sur les soumissions. */
export function cleanBusiness(body) {
  const businessEmail = email(body.businessEmail, 'businessEmail', { required: false });
  const phone = str(body.businessPhone, 'businessPhone', { max: 40, label: 'Le téléphone' });
  if (phone && !PHONE_RE.test(phone)) throw bad('businessPhone', 'Téléphone invalide.');
  return {
    business_phone: phone || null,
    business_email: businessEmail || null,
    business_address: str(body.businessAddress, 'businessAddress', { max: 200, label: "L'adresse" }) || null,
    rbq_number: str(body.rbqNumber, 'rbqNumber', { max: 30, label: 'Le numéro RBQ' }) || null,
    gst_number: str(body.gstNumber, 'gstNumber', { max: 30, label: 'Le numéro de TPS' }) || null,
    qst_number: str(body.qstNumber, 'qstNumber', { max: 30, label: 'Le numéro de TVQ' }) || null,
    charge_taxes: body.chargeTaxes === false ? 0 : 1,
    default_terms: multiline(body.defaultTerms, 'defaultTerms', { max: 4000, label: 'Les conditions' }) || null,
    payment_instructions: multiline(body.paymentInstructions, 'paymentInstructions', { max: 1000, label: 'Les instructions de paiement' }) || null,
    invoice_due_days: dueDays(body.invoiceDueDays),
    margin_floor_pct: intIn(body.marginFloorPct, 'marginFloorPct', { min: 0, max: 90, fallback: null, label: 'Plancher de marge : entre 0 et 90 %.' }),
    deposit_pct: intIn(body.depositPct, 'depositPct', { min: 0, max: 100, fallback: 0, label: 'Acompte : entre 0 et 100 %.' }),
  };
}

function intIn(value, field, { min, max, fallback, label }) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(typeof value === 'string' ? value.replace(/[\s%]/g, '').replace(',', '.') : value);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(field, label);
  return n;
}

function dueDays(value) {
  if (value === undefined || value === null || value === '') return 30;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 120) throw bad('invoiceDueDays', 'Délai de paiement : entre 0 et 120 jours.');
  return n;
}

export const PAYMENT_METHODS = ['interac', 'cheque', 'cash', 'card', 'other'];

/** Facture : toujours détaillée (au moins une ligne). */
export function cleanInvoice(input, { depositAppliedCents = 0 } = {}) {
  if (!input || typeof input !== 'object') throw bad('invoice', 'Facture invalide.');
  const items = cleanItems(input.items);
  if (!items) throw bad('items.0.description', 'Ajoute au moins une ligne à la facture.');
  for (const it of items) {
    it.optional = false; // une facture n'a pas d'options : tout ce qui y figure est dû
    delete it.costCents; // le coût reste sur la soumission
    delete it.itemId;
  }
  const money = detailedMoney(items, input, { deductionCents: depositAppliedCents });
  const issued = isoDate(input.issuedOn ?? input.issued_on, 'issuedOn', { required: true, label: 'La date de facture' });
  const due = isoDate(input.dueOn ?? input.due_on, 'dueOn', { required: true, label: "La date d'échéance" });
  if (due < issued) throw bad('dueOn', "L'échéance doit être le jour de la facture ou après.");
  const clientEmail = email(input.clientEmail ?? input.client_email, 'clientEmail', { required: false });
  const phone = str(input.clientPhone ?? input.client_phone, 'clientPhone', { max: 40, label: 'Le téléphone' });
  if (phone && !PHONE_RE.test(phone)) throw bad('clientPhone', 'Téléphone invalide.');
  return {
    client: str(input.client, 'client', { max: 120, required: true, label: 'Le nom du client' }),
    project: str(input.project, 'project', { max: 160, required: true, label: 'Le projet' }),
    client_email: clientEmail || null,
    client_phone: phone || null,
    client_address: str(input.clientAddress ?? input.client_address, 'clientAddress', { max: 200, label: "L'adresse" }) || null,
    items_json: money.items_json,
    subtotal_cents: money.subtotal_cents,
    discount_cents: money.discount_cents,
    taxes: money.taxes,
    gst_cents: money.gst_cents,
    qst_cents: money.qst_cents,
    total_cents: money.amount_cents,
    issued_on: issued,
    due_on: due,
    terms: multiline(input.terms, 'terms', { max: 4000, label: 'Les conditions' }) || null,
    notes: multiline(input.notes, 'notes', { max: 2000, label: 'Les notes' }) || null,
    work_end_on: isoDate(input.workEndOn ?? input.work_end_on, 'workEndOn', { label: 'La date de fin des travaux' }),
  };
}

export function invoiceToJson(row) {
  return {
    id: row.id,
    quoteId: row.quote_id || null,
    number: row.number,
    client: row.client,
    project: row.project,
    clientEmail: row.client_email || '',
    clientPhone: row.client_phone || '',
    clientAddress: row.client_address || '',
    items: itemsToJson(parseItems(row.items_json)),
    subtotal: row.subtotal_cents / 100,
    discount: (row.discount_cents || 0) / 100,
    taxes: Boolean(row.taxes),
    gst: (row.gst_cents || 0) / 100,
    qst: (row.qst_cents || 0) / 100,
    total: row.total_cents / 100,
    amount: row.total_cents / 100,
    issuedOn: row.issued_on,
    dueOn: row.due_on,
    status: row.status,
    paidOn: row.paid_on || null,
    paymentMethod: row.payment_method || null,
    terms: row.terms || '',
    notes: row.notes || '',
    kind: row.kind === 'deposit' ? 'deposit' : 'standard',
    depositQuoteId: row.deposit_quote_id || null,
    depositApplied: (row.deposit_applied_cents || 0) / 100,
    depositRef: row.deposit_ref || '',
    workEndOn: row.work_end_on || null,
    reminderCount: row.reminder_count || 0,
    lastReminderOn: row.last_reminder_on || null,
    shareToken: row.share_token || null,
    sharedAt: row.shared_at || null,
    viewCount: row.view_count || 0,
    firstViewedAt: row.first_viewed_at || null,
    lastViewedAt: row.last_viewed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function parseItems(itemsJson) {
  if (!itemsJson) return null;
  try {
    const items = JSON.parse(itemsJson);
    return Array.isArray(items) ? items : null;
  } catch {
    return null;
  }
}

/** Lignes pour l'API. owner = l'entrepreneur : coûts et liens vers la bibliothèque inclus (jamais pour le client). */
export function itemsToJson(items, { owner = false } = {}) {
  return (items || []).map((it) => ({
    description: it.description,
    unit: it.unit || '',
    qty: it.qtyMilli / 1000,
    unitPrice: it.unitCents / 100,
    total: (Number.isInteger(it.lineCents) ? it.lineCents : lineCents(it.qtyMilli, it.unitCents)) / 100,
    optional: Boolean(it.optional),
    ...(it.optional && typeof it.selected === 'boolean' ? { selected: it.selected } : {}),
    ...(owner && Number.isInteger(it.costCents) ? { unitCost: it.costCents / 100 } : {}),
    ...(owner && it.itemId ? { itemId: it.itemId } : {}),
  }));
}

export function quoteToJson(row) {
  const items = parseItems(row.items_json);
  return {
    id: row.id,
    number: row.number || '',
    client: row.client,
    project: row.project,
    amount: row.amount_cents / 100,
    detailed: Boolean(items),
    items: itemsToJson(items, { owner: true }),
    subtotal: row.subtotal_cents === null || row.subtotal_cents === undefined ? null : row.subtotal_cents / 100,
    discount: (row.discount_cents || 0) / 100,
    taxes: Boolean(row.taxes),
    gst: (row.gst_cents || 0) / 100,
    qst: (row.qst_cents || 0) / 100,
    status: row.status,
    sentOn: row.sent_on,
    followUpOn: row.follow_up_on,
    validUntil: row.valid_until || null,
    clientEmail: row.client_email || '',
    clientPhone: row.client_phone || '',
    clientAddress: row.client_address || '',
    notes: row.notes || '',
    terms: row.terms || '',
    followUpCount: row.follow_up_count,
    lastFollowUpOn: row.last_follow_up_on,
    shareToken: row.share_token || null,
    sharedAt: row.shared_at || null,
    viewCount: row.view_count || 0,
    firstViewedAt: row.first_viewed_at || null,
    lastViewedAt: row.last_viewed_at || null,
    decidedOnlineAt: row.decided_online_at || null,
    decidedByName: row.decided_by_name || '',
    clientMessage: row.client_message || '',
    signedInPerson: Boolean(row.signed_in_person),
    signedAtHome: Boolean(row.signed_at_home),
    hasSignature: Boolean(row.signature_png),
    subcontract: Boolean(row.subcontract),
    denouncedOn: row.denounced_on || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------- Signature ----------
const SIGNATURE_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
export const MAX_SIGNATURE = 150_000;

/** Signature au doigt : image PNG en data URL, taille bornée. */
export function signature(value, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw bad('signature', 'La signature est requise.');
    return null;
  }
  if (typeof value !== 'string' || value.length > MAX_SIGNATURE || !SIGNATURE_RE.test(value)) {
    throw bad('signature', 'Signature invalide. Effacez et signez de nouveau.');
  }
  return value;
}

// ---------- Bibliothèque ----------
/** Article (prix, coût privé) ou forfait (groupe de lignes). */
export function cleanCatalog(input) {
  if (!input || typeof input !== 'object') throw bad('catalog', 'Article invalide.');
  const kind = input.kind === 'package' ? 'package' : 'item';
  const name = str(input.name, 'name', { max: 120, required: true, label: 'Le nom' });
  const category = str(input.category, 'category', { max: 40, label: 'La catégorie' }) || null;
  if (kind === 'item') {
    const unit = str(input.unit, 'unit', { max: 12, label: "L'unité" }) || null;
    if (!filled(input.price)) throw bad('price', 'Le prix est requis.');
    const price = toCents(input.price);
    if (price === null) throw bad('price', 'Prix invalide.');
    let cost = null;
    if (filled(input.cost)) {
      cost = toCents(input.cost);
      if (cost === null) throw bad('cost', 'Coût invalide.');
    }
    return { kind, name, category, unit, price_cents: price, cost_cents: cost, lines_json: null };
  }
  const lines = cleanItems(input.lines, { max: 60 });
  if (!lines) throw bad('lines', 'Un forfait contient au moins une ligne.');
  return { kind, name, category, unit: null, price_cents: null, cost_cents: null, lines_json: JSON.stringify(lines) };
}

export function catalogToJson(row) {
  const base = {
    id: row.id,
    kind: row.kind === 'package' ? 'package' : 'item',
    name: row.name,
    category: row.category || '',
    useCount: row.use_count || 0,
    lastUsedAt: row.last_used_at || null,
    priceUpdatedAt: row.price_updated_at || row.created_at,
    updatedAt: row.updated_at,
  };
  if (base.kind === 'item') {
    return {
      ...base, unit: row.unit || '', price: row.price_cents / 100,
      cost: Number.isInteger(row.cost_cents) ? row.cost_cents / 100 : null,
    };
  }
  return { ...base, lines: itemsToJson(parseItems(row.lines_json), { owner: true }) };
}
