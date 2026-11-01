import { HttpError, json, readJson } from '../lib/http.js';
import { newId, randomToken } from '../lib/crypto.js';
import { requireUser } from '../lib/session.js';
import { assertCanWrite, track } from '../lib/guards.js';
import { cleanQuote, isoDate, quoteToJson, str } from '../lib/validate.js';

const MAX_QUOTES_PER_USER = 5000;
const MAX_IMPORT = 1000;

// Colonnes écrites à partir d'une soumission validée (cleanQuote).
const WRITE_COLS = [
  'client', 'project', 'amount_cents', 'status', 'sent_on', 'follow_up_on', 'valid_until',
  'client_email', 'client_phone', 'client_address', 'notes', 'terms',
  'items_json', 'subtotal_cents', 'discount_cents', 'taxes', 'gst_cents', 'qst_cents',
];

async function countQuotes(env, userId) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM quotes WHERE user_id = ?').bind(userId).first();
  return row ? row.n : 0;
}

function insertStmt(env, userId, q, now, { id = newId(), number = null } = {}) {
  const cols = ['id', 'user_id', 'number', ...WRITE_COLS, 'follow_up_count', 'last_follow_up_on', 'created_at', 'updated_at'];
  const values = [id, userId, number, ...WRITE_COLS.map((c) => q[c] ?? null), q.follow_up_count || 0, q.last_follow_up_on || null, now, now];
  return env.DB.prepare(`INSERT INTO quotes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...values);
}

async function getOwned(env, userId, id) {
  const row = await env.DB.prepare('SELECT * FROM quotes WHERE id = ? AND user_id = ?').bind(id, userId).first();
  if (!row) throw new HttpError(404, 'not_found', 'Soumission introuvable.');
  return row;
}

/** Numéro séquentiel par entreprise : 2026-001, 2026-002… */
async function nextNumber(env, userId) {
  const row = await env.DB.prepare(
    'UPDATE users SET next_quote_number = next_quote_number + 1 WHERE id = ? RETURNING next_quote_number - 1 AS n'
  ).bind(userId).first();
  const year = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric' }).format(new Date());
  return `${year}-${String(row ? row.n : 1).padStart(3, '0')}`;
}

export async function listQuotes(request, env) {
  const user = await requireUser(env, request);
  const { results } = await env.DB.prepare(
    'SELECT * FROM quotes WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?'
  ).bind(user.id, MAX_QUOTES_PER_USER).all();
  return json({ quotes: results.map(quoteToJson) });
}

export async function createQuote(request, env) {
  const user = await requireUser(env, request);
  assertCanWrite(user, env);
  const q = cleanQuote(await readJson(request, 60_000));
  const existing = await countQuotes(env, user.id);
  if (existing >= MAX_QUOTES_PER_USER) throw new HttpError(409, 'quota', 'Limite de soumissions atteinte. Écris-nous.');
  const id = newId();
  await insertStmt(env, user.id, q, Date.now(), { id, number: await nextNumber(env, user.id) }).run();
  await track(env, existing === 0 ? 'first_quote' : 'quote_created', user.id);
  if (q.items_json) await track(env, 'quote_detailed', user.id);
  return json({ quote: quoteToJson(await getOwned(env, user.id, id)) }, 201);
}

export async function updateQuote(request, env, id) {
  const user = await requireUser(env, request);
  assertCanWrite(user, env);
  const before = await getOwned(env, user.id, id);
  const q = cleanQuote(await readJson(request, 60_000));
  const sets = WRITE_COLS.map((c) => `${c} = ?`);
  const values = WRITE_COLS.map((c) => q[c] ?? null);
  // Remise « en attente » d'une soumission décidée en ligne : le client peut de nouveau répondre.
  if (q.status === 'pending' && before.decided_online_at) {
    sets.push('decided_online_at = NULL', 'decided_by_name = NULL', 'client_message = NULL', 'accepted_snapshot = NULL');
  }
  await env.DB.prepare(`UPDATE quotes SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND user_id = ?`)
    .bind(...values, Date.now(), id, user.id).run();
  if (before.status !== q.status && q.status === 'accepted') await track(env, 'quote_won', user.id);
  return json({ quote: quoteToJson(await getOwned(env, user.id, id)) });
}

/** « Relance faite » : incrémente le compteur et planifie (ou non) la prochaine. */
export async function markFollowUp(request, env, id) {
  const user = await requireUser(env, request);
  assertCanWrite(user, env);
  await getOwned(env, user.id, id);
  const body = await readJson(request, 2_000);
  const doneOn = isoDate(body.doneOn, 'doneOn', { required: true, label: 'La date de relance' });
  const next = isoDate(body.nextFollowUpOn, 'nextFollowUpOn', { label: 'La prochaine relance' });
  if (next && next < doneOn) {
    throw new HttpError(400, 'validation_error', 'La prochaine relance doit être après aujourd’hui.', { field: 'nextFollowUpOn' });
  }
  await env.DB.prepare(
    `UPDATE quotes SET follow_up_count = follow_up_count + 1, last_follow_up_on = ?, follow_up_on = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).bind(doneOn, next, Date.now(), id, user.id).run();
  await track(env, 'follow_up_done', user.id);
  return json({ quote: quoteToJson(await getOwned(env, user.id, id)) });
}

/** Crée (ou retourne) le lien client de la soumission. */
export async function shareQuote(request, env, id) {
  const user = await requireUser(env, request);
  assertCanWrite(user, env);
  const q = await getOwned(env, user.id, id);
  if (!q.share_token) {
    const now = Date.now();
    await env.DB.prepare('UPDATE quotes SET share_token = ?, shared_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND share_token IS NULL')
      .bind(randomToken(24), now, now, id, user.id).run();
    await track(env, 'quote_shared', user.id);
  }
  return json({ quote: quoteToJson(await getOwned(env, user.id, id)) });
}

/** Désactive le lien client (l'ancien lien cesse de fonctionner). */
export async function unshareQuote(request, env, id) {
  const user = await requireUser(env, request);
  await getOwned(env, user.id, id);
  await env.DB.prepare('UPDATE quotes SET share_token = NULL, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(Date.now(), id, user.id).run();
  return json({ quote: quoteToJson(await getOwned(env, user.id, id)) });
}

export async function deleteQuote(request, env, id) {
  const user = await requireUser(env, request);
  assertCanWrite(user, env);
  const res = await env.DB.prepare('DELETE FROM quotes WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  if (!res.meta || res.meta.changes === 0) throw new HttpError(404, 'not_found', 'Soumission introuvable.');
  return json({ ok: true });
}

/** Import en lot (export JSON, ancienne démo locale). Lignes invalides ignorées et comptées. */
export async function importQuotes(request, env) {
  const user = await requireUser(env, request);
  assertCanWrite(user, env);
  const body = await readJson(request, 4_000_000);
  if (!Array.isArray(body.quotes)) throw new HttpError(400, 'validation_error', 'Fichier d’import invalide.');
  if (body.quotes.length > MAX_IMPORT) throw new HttpError(413, 'too_many', `Maximum ${MAX_IMPORT} soumissions par import.`);
  const existing = await countQuotes(env, user.id);
  if (existing + body.quotes.length > MAX_QUOTES_PER_USER) throw new HttpError(409, 'quota', 'Limite de soumissions atteinte.');

  const valid = [];
  const errors = [];
  body.quotes.forEach((raw, index) => {
    try {
      const q = cleanQuote(raw);
      const count = Number(raw && (raw.followUpCount ?? raw.follow_up_count));
      q.follow_up_count = Number.isInteger(count) && count >= 0 && count < 1000 ? count : 0;
      try {
        q.last_follow_up_on = isoDate(raw.lastFollowUpOn ?? raw.last_follow_up_on, 'lastFollowUpOn');
      } catch { q.last_follow_up_on = null; }
      let number = null;
      try { number = str(raw.number, 'number', { max: 20 }) || null; } catch { number = null; }
      valid.push({ q, number });
    } catch (err) {
      errors.push({ index, message: err.message });
    }
  });

  const now = Date.now();
  for (let i = 0; i < valid.length; i += 50) {
    await env.DB.batch(valid.slice(i, i + 50).map(({ q, number }, j) => insertStmt(env, user.id, q, now + i + j, { number })));
  }
  if (valid.length) await track(env, existing === 0 ? 'first_quote' : 'quotes_imported', user.id);
  return json({ imported: valid.length, skipped: errors.length, errors: errors.slice(0, 20) });
}
