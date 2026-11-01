// Factures : créées à partir d'une soumission, payées par le client hors de l'app (Interac, chèque…).
import { HttpError, json, readJson, clientIp } from '../lib/http.js';
import { newId, randomToken } from '../lib/crypto.js';
import { getSessionUser, requireUser } from '../lib/session.js';
import { assertCanWrite, rateLimit, track } from '../lib/guards.js';
import {
  PAYMENT_METHODS, cleanInvoice, invoiceToJson, isoDate, itemsToJson, parseItems,
} from '../lib/validate.js';
import { TOKEN_RE, todayToronto } from './public.js';

const MAX_INVOICES_PER_USER = 5000;
const VIEW_WINDOW_MS = 30 * 60 * 1000;
const WRITE_COLS = [
  'client', 'project', 'client_email', 'client_phone', 'client_address', 'items_json', 'subtotal_cents',
  'discount_cents', 'taxes', 'gst_cents', 'qst_cents', 'total_cents', 'issued_on', 'due_on', 'terms', 'notes',
];

function addDays(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function getOwned(env, userId, id) {
  const row = await env.DB.prepare('SELECT * FROM invoices WHERE id = ? AND user_id = ?').bind(id, userId).first();
  if (!row) throw new HttpError(404, 'not_found', 'Facture introuvable.');
  return row;
}

function assertStatus(row, expected, message) {
  if (row.status !== expected) throw new HttpError(409, 'bad_status', message);
}

async function nextNumber(env, userId) {
  const row = await env.DB.prepare(
    'UPDATE users SET next_invoice_number = next_invoice_number + 1 WHERE id = ? RETURNING next_invoice_number - 1 AS n'
  ).bind(userId).first();
  return `F-${todayToronto().slice(0, 4)}-${String(row ? row.n : 1).padStart(3, '0')}`;
}

export async function listInvoices(request, env) {
  const user = await requireUser(env, request);
  const { results } = await env.DB.prepare('SELECT * FROM invoices WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?')
    .bind(user.id, MAX_INVOICES_PER_USER).all();
  return json({ invoices: results.map(invoiceToJson) });
}

/** Lignes de départ de la facture : version acceptée en ligne si elle existe, sinon la soumission actuelle. */
function sourceOf(quote) {
  let snap = null;
  if (quote.status === 'accepted' && quote.accepted_snapshot) {
    try { snap = JSON.parse(quote.accepted_snapshot); } catch { snap = null; }
  }
  if (snap && snap.detailed) {
    return { items: snap.items, discount: snap.discount, taxes: snap.taxes, terms: snap.terms, project: snap.project };
  }
  const all = parseItems(quote.items_json);
  // Options : seulement celles que le client a retenues (une option jamais choisie n'est pas facturée).
  const items = all ? all.filter((it) => !it.optional || it.selected === true) : null;
  if (items && items.length) {
    return {
      items: itemsToJson(items), discount: (quote.discount_cents || 0) / 100, taxes: Boolean(quote.taxes),
      terms: quote.terms || '', project: quote.project,
    };
  }
  // Soumission à montant simple : une seule ligne, montant tel quel.
  return {
    items: [{ description: quote.project, qty: 1, unit: '', unitPrice: quote.amount_cents / 100 }],
    discount: 0, taxes: false, terms: quote.terms || '', project: quote.project,
  };
}

export async function createFromQuote(request, env, quoteId) {
  const user = await requireUser(env, request);
  assertCanWrite(user, env);
  const quote = await env.DB.prepare('SELECT * FROM quotes WHERE id = ? AND user_id = ?').bind(quoteId, user.id).first();
  if (!quote) throw new HttpError(404, 'not_found', 'Soumission introuvable.');
  const existing = await env.DB.prepare('SELECT * FROM invoices WHERE quote_id = ? AND user_id = ?').bind(quoteId, user.id).first();
  if (existing) return json({ invoice: invoiceToJson(existing), created: false });
  if (quote.status === 'refused') throw new HttpError(409, 'refused', 'Cette soumission est refusée : rien à facturer.');
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM invoices WHERE user_id = ?').bind(user.id).first();
  if (count && count.n >= MAX_INVOICES_PER_USER) throw new HttpError(409, 'quota', 'Limite de factures atteinte. Écris-nous.');

  const src = sourceOf(quote);
  const issuedOn = todayToronto();
  const dueDays = Number.isInteger(user.invoice_due_days) ? user.invoice_due_days : 30;
  const inv = cleanInvoice({
    client: quote.client, project: src.project, clientEmail: quote.client_email, clientPhone: quote.client_phone,
    clientAddress: quote.client_address, items: src.items, discount: src.discount, taxes: src.taxes,
    issuedOn, dueOn: addDays(issuedOn, dueDays), terms: src.terms, notes: '',
  });
  const id = newId();
  const now = Date.now();
  const cols = ['id', 'user_id', 'quote_id', 'number', ...WRITE_COLS, 'created_at', 'updated_at'];
  try {
    await env.DB.prepare(`INSERT INTO invoices (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .bind(id, user.id, quoteId, await nextNumber(env, user.id), ...WRITE_COLS.map((c) => inv[c] ?? null), now, now).run();
  } catch (err) {
    // Double clic : l'index unique sur quote_id garantit une seule facture.
    if (String(err && err.message).includes('UNIQUE')) {
      const again = await env.DB.prepare('SELECT * FROM invoices WHERE quote_id = ? AND user_id = ?').bind(quoteId, user.id).first();
      if (again) return json({ invoice: invoiceToJson(again), created: false });
    }
    throw err;
  }
  await track(env, 'invoice_created', user.id);
  return json({ invoice: invoiceToJson(await getOwned(env, user.id, id)), created: true }, 201);
}

export async function updateInvoice(request, env, id) {
  const user = await requireUser(env, request);
  assertCanWrite(user, env);
  const row = await getOwned(env, user.id, id);
  assertStatus(row, 'unpaid', row.status === 'paid'
    ? 'Facture payée : annule le paiement avant de la modifier.'
    : 'Facture annulée : elle ne peut plus être modifiée.');
  const inv = cleanInvoice(await readJson(request, 60_000));
  await env.DB.prepare(`UPDATE invoices SET ${WRITE_COLS.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND user_id = ?`)
    .bind(...WRITE_COLS.map((c) => inv[c] ?? null), Date.now(), id, user.id).run();
  return json({ invoice: invoiceToJson(await getOwned(env, user.id, id)) });
}

export async function markPaid(request, env, id) {
  const user = await requireUser(env, request);
  assertCanWrite(user, env);
  const row = await getOwned(env, user.id, id);
  assertStatus(row, 'unpaid', 'Seule une facture à payer peut être marquée payée.');
  const body = await readJson(request, 2_000);
  const paidOn = isoDate(body.paidOn, 'paidOn', { required: true, label: 'La date de paiement' });
  const method = body.method || 'other';
  if (!PAYMENT_METHODS.includes(method)) throw new HttpError(400, 'validation_error', 'Mode de paiement invalide.', { field: 'method' });
  await env.DB.prepare("UPDATE invoices SET status = 'paid', paid_on = ?, payment_method = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(paidOn, method, Date.now(), id, user.id).run();
  await track(env, 'invoice_paid', user.id);
  return json({ invoice: invoiceToJson(await getOwned(env, user.id, id)) });
}

export async function unmarkPaid(request, env, id) {
  const user = await requireUser(env, request);
  assertCanWrite(user, env);
  const row = await getOwned(env, user.id, id);
  assertStatus(row, 'paid', 'Cette facture n’est pas marquée payée.');
  await env.DB.prepare("UPDATE invoices SET status = 'unpaid', paid_on = NULL, payment_method = NULL, updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(Date.now(), id, user.id).run();
  return json({ invoice: invoiceToJson(await getOwned(env, user.id, id)) });
}

/** Annulation : la facture reste (numéro conservé, traçabilité comptable) mais ne compte plus. */
export async function voidInvoice(request, env, id) {
  const user = await requireUser(env, request);
  assertCanWrite(user, env);
  const row = await getOwned(env, user.id, id);
  assertStatus(row, 'unpaid', 'Seule une facture à payer peut être annulée.');
  await env.DB.prepare("UPDATE invoices SET status = 'void', updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(Date.now(), id, user.id).run();
  return json({ invoice: invoiceToJson(await getOwned(env, user.id, id)) });
}

export async function recordReminder(request, env, id) {
  const user = await requireUser(env, request);
  assertCanWrite(user, env);
  const row = await getOwned(env, user.id, id);
  assertStatus(row, 'unpaid', 'Seule une facture à payer peut être relancée.');
  await env.DB.prepare('UPDATE invoices SET reminder_count = reminder_count + 1, last_reminder_on = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(todayToronto(), Date.now(), id, user.id).run();
  await track(env, 'invoice_reminder', user.id);
  return json({ invoice: invoiceToJson(await getOwned(env, user.id, id)) });
}

export async function shareInvoice(request, env, id) {
  const user = await requireUser(env, request);
  assertCanWrite(user, env);
  const row = await getOwned(env, user.id, id);
  if (!row.share_token) {
    const now = Date.now();
    await env.DB.prepare('UPDATE invoices SET share_token = ?, shared_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND share_token IS NULL')
      .bind(randomToken(24), now, now, id, user.id).run();
    await track(env, 'invoice_shared', user.id);
  }
  return json({ invoice: invoiceToJson(await getOwned(env, user.id, id)) });
}

export async function unshareInvoice(request, env, id) {
  const user = await requireUser(env, request);
  await getOwned(env, user.id, id);
  await env.DB.prepare('UPDATE invoices SET share_token = NULL, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(Date.now(), id, user.id).run();
  return json({ invoice: invoiceToJson(await getOwned(env, user.id, id)) });
}

// ---------- Page publique /f/:jeton ----------
export async function getPublicInvoice(request, env, token) {
  await rateLimit(env, `pub:${clientIp(request)}`, 300, 900);
  if (!TOKEN_RE.test(token)) throw new HttpError(404, 'not_found', 'Facture introuvable.');
  const row = await env.DB.prepare(
    `SELECT i.*, u.display_name, u.company, u.business_phone, u.business_email, u.business_address,
            u.rbq_number, u.gst_number, u.qst_number, u.payment_instructions
     FROM invoices i JOIN users u ON u.id = i.user_id WHERE i.share_token = ?`
  ).bind(token).first();
  if (!row) throw new HttpError(404, 'not_found', 'Ce lien n’est plus actif. Communique avec l’entrepreneur pour obtenir ta facture.');
  const viewer = await getSessionUser(env, request);
  const isOwner = Boolean(viewer && viewer.id === row.user_id);
  if (!isOwner) {
    const now = Date.now();
    const counts = !row.last_viewed_at || now - row.last_viewed_at > VIEW_WINDOW_MS;
    await env.DB.prepare(
      'UPDATE invoices SET view_count = view_count + ?, first_viewed_at = COALESCE(first_viewed_at, ?), last_viewed_at = ? WHERE id = ?'
    ).bind(counts ? 1 : 0, now, now, row.id).run();
    if (!row.first_viewed_at) await track(env, 'invoice_viewed', row.user_id);
  }
  const inv = invoiceToJson(row);
  return json({
    invoice: {
      number: inv.number, project: inv.project, client: inv.client, clientAddress: inv.clientAddress,
      issuedOn: inv.issuedOn, dueOn: inv.dueOn, detailed: true, items: inv.items, subtotal: inv.subtotal,
      discount: inv.discount, taxes: inv.taxes, gst: inv.gst, qst: inv.qst, total: inv.total, terms: inv.terms,
      status: inv.status, paidOn: inv.paidOn, overdue: inv.status === 'unpaid' && inv.dueOn < todayToronto(),
    },
    business: {
      name: row.company || row.display_name || 'Entrepreneur',
      contact: row.company ? (row.display_name || '') : '',
      phone: row.business_phone || '',
      email: row.business_email || '',
      address: row.business_address || '',
      rbq: row.rbq_number || '',
      gstNumber: row.gst_number || '',
      qstNumber: row.qst_number || '',
      paymentInstructions: row.payment_instructions || '',
    },
    viewer: { isOwner },
  }, 200, { 'x-robots-tag': 'noindex, nofollow' });
}
