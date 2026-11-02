// Lien client : page publique d'une soumission, ouvertures, acceptation ou refus en ligne.
import { HttpError, json, readJson, clientIp } from '../lib/http.js';
import { getSessionUser } from '../lib/session.js';
import { rateLimit, track } from '../lib/guards.js';
import { itemsToJson, multiline, parseItems, signature as vSignature, str, MAX_SIGNATURE } from '../lib/validate.js';
import { computeTotals } from '../../public/assets/money.js';
import { TOKEN_RE, todayToronto } from '../lib/dates.js';
import { ensureDeposit } from './invoices.js';

export { TOKEN_RE, todayToronto };
const VIEW_WINDOW_MS = 30 * 60 * 1000; // une « ouverture » = une visite, pas chaque rechargement

async function findByToken(env, token) {
  if (!TOKEN_RE.test(token)) return null;
  return env.DB.prepare(
    `SELECT q.*, u.display_name, u.company, u.business_phone, u.business_email, u.business_address,
            u.rbq_number, u.gst_number, u.qst_number
     FROM quotes q JOIN users u ON u.id = q.user_id
     WHERE q.share_token = ?`
  ).bind(token).first();
}

/** Contenu du document tel que le client le voit (jamais les notes privées ni les coordonnées du client). */
function documentOf(row) {
  // Après acceptation, les options non retenues disparaissent du document (selected === false).
  const all = parseItems(row.items_json);
  const items = all ? all.filter((it) => !(it.optional && it.selected === false)) : null;
  return {
    number: row.number || '',
    project: row.project,
    client: row.client,
    clientAddress: row.client_address || '',
    sentOn: row.sent_on,
    validUntil: row.valid_until || null,
    detailed: Boolean(items),
    items: itemsToJson(items),
    subtotal: row.subtotal_cents === null || row.subtotal_cents === undefined ? null : row.subtotal_cents / 100,
    discount: (row.discount_cents || 0) / 100,
    taxes: Boolean(row.taxes),
    gst: (row.gst_cents || 0) / 100,
    qst: (row.qst_cents || 0) / 100,
    total: row.amount_cents / 100,
    terms: row.terms || '',
  };
}

function payload(row, isOwner) {
  let doc = null;
  if (row.status === 'accepted' && row.accepted_snapshot) {
    try { doc = JSON.parse(row.accepted_snapshot); } catch { doc = null; }
  }
  doc = doc || documentOf(row);
  const expired = row.status === 'pending' && Boolean(row.valid_until) && row.valid_until < todayToronto();
  return {
    quote: {
      ...doc,
      status: row.status,
      expired,
      decidedOnline: Boolean(row.decided_online_at),
      decidedAt: row.decided_online_at || null,
      decidedByName: row.decided_by_name || '',
      signedInPerson: Boolean(row.signed_in_person),
      signature: row.status === 'accepted' && row.signature_png ? row.signature_png : null,
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
    },
    viewer: { isOwner },
  };
}

const NOT_FOUND = 'Ce lien n’est plus actif. Communique avec l’entrepreneur pour obtenir sa soumission.';

export async function getPublicQuote(request, env, token) {
  await rateLimit(env, `pub:${clientIp(request)}`, 300, 900);
  const row = await findByToken(env, token);
  if (!row) throw new HttpError(404, 'not_found', NOT_FOUND);
  const viewer = await getSessionUser(env, request);
  const isOwner = Boolean(viewer && viewer.id === row.user_id);
  if (!isOwner) {
    const now = Date.now();
    const counts = !row.last_viewed_at || now - row.last_viewed_at > VIEW_WINDOW_MS;
    await env.DB.prepare(
      'UPDATE quotes SET view_count = view_count + ?, first_viewed_at = COALESCE(first_viewed_at, ?), last_viewed_at = ? WHERE id = ?'
    ).bind(counts ? 1 : 0, now, now, row.id).run();
    if (!row.first_viewed_at) await track(env, 'quote_viewed', row.user_id);
  }
  return json(payload(row, isOwner), 200, { 'x-robots-tag': 'noindex, nofollow' });
}

/** Nom, confirmation, options et signature d'une acceptation (en ligne ou sur place). */
export function parseAcceptance(body, { requireSignature = false } = {}) {
  const name = str(body.name, 'name', { max: 120, required: true, label: 'Le nom' });
  if (name.length < 2) throw new HttpError(400, 'validation_error', 'Le nom complet est requis.', { field: 'name' });
  if (body.confirm !== true) {
    throw new HttpError(400, 'validation_error', 'Cochez la case pour confirmer l’acceptation.', { field: 'confirm' });
  }
  return {
    name,
    options: Array.isArray(body.options) ? body.options : [],
    signature: vSignature(body.signature, { required: requireSignature }),
  };
}

/**
 * Accepte une soumission en attente : options choisies (totaux recalculés par money.js), version figée,
 * signature. Retourne false si quelqu'un a répondu entre-temps.
 */
export async function acceptQuote(env, row, { name, options = [], signature = null, inPerson = false, atHome = false, message = null }) {
  let accepted = row;
  const items = parseItems(row.items_json);
  if (items && items.some((it) => it.optional)) {
    const chosen = new Set();
    for (const v of options) {
      if (!Number.isInteger(v) || !items[v] || !items[v].optional) {
        throw new HttpError(400, 'validation_error', 'Option invalide.', { field: 'options' });
      }
      chosen.add(v);
    }
    const lines = items.map((it, i) => ({ ...it, selected: it.optional ? chosen.has(i) : undefined }));
    const t = computeTotals(lines.map((l) => ({ ...l, excluded: l.optional && !l.selected })), row.discount_cents || 0, Boolean(row.taxes));
    if (t.error) throw new HttpError(400, 'validation_error', 'Total invalide.', { field: 'options' });
    accepted = {
      ...row,
      items_json: JSON.stringify(lines.map((l, i) => ({ ...l, lineCents: t.lineTotals[i] }))),
      subtotal_cents: t.subtotalCents, gst_cents: t.gstCents, qst_cents: t.qstCents, amount_cents: t.totalCents,
    };
  }
  const now = Date.now();
  const res = await env.DB.prepare(
    `UPDATE quotes SET status = 'accepted', decided_online_at = ?, decided_by_name = ?, client_message = ?, accepted_snapshot = ?,
       items_json = ?, subtotal_cents = ?, gst_cents = ?, qst_cents = ?, amount_cents = ?, follow_up_on = NULL,
       signature_png = ?, signed_in_person = ?, signed_at_home = ?, updated_at = ?
     WHERE id = ? AND status = 'pending'`
  ).bind(now, name, message, JSON.stringify(documentOf(accepted)),
    accepted.items_json ?? null, accepted.subtotal_cents ?? null, accepted.gst_cents || 0, accepted.qst_cents || 0, accepted.amount_cents,
    signature, inPerson ? 1 : 0, inPerson && atHome ? 1 : 0, now, row.id).run();
  return Boolean(res.meta && res.meta.changes === 1);
}

export async function decidePublicQuote(request, env, token) {
  await rateLimit(env, `pub-decide:${clientIp(request)}`, 20, 3600);
  const body = await readJson(request, MAX_SIGNATURE + 6_000);
  const decision = body.decision;
  if (decision !== 'accept' && decision !== 'refuse') throw new HttpError(400, 'validation_error', 'Choix invalide.');

  const row = await findByToken(env, token);
  if (!row) throw new HttpError(404, 'not_found', NOT_FOUND);
  const viewer = await getSessionUser(env, request);
  if (viewer && viewer.id === row.user_id) {
    throw new HttpError(403, 'owner', 'C’est ta propre soumission : seul ton client peut y répondre. Pour la faire signer devant toi, utilise « Faire signer ici » dans l’app.');
  }
  if (row.status !== 'pending') throw new HttpError(409, 'already_decided', 'Cette soumission a déjà reçu une réponse.');
  if (row.valid_until && row.valid_until < todayToronto()) {
    throw new HttpError(409, 'expired', 'Cette soumission est expirée. Communique avec l’entrepreneur pour une mise à jour.');
  }
  const message = multiline(body.message, 'message', { max: 1000, label: 'Le message' }) || null;

  if (decision === 'accept') {
    const a = parseAcceptance(body);
    const ok = await acceptQuote(env, row, { ...a, message });
    if (!ok) throw new HttpError(409, 'already_decided', 'Cette soumission a déjà reçu une réponse.');
    await track(env, 'quote_accepted_online', row.user_id);
    if (a.signature) await track(env, 'quote_signed_online', row.user_id);
    const owner = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(row.user_id).first();
    if (owner) {
      try { await ensureDeposit(env, owner, row.id); } catch (err) { console.error('deposit failed', err); }
    }
    return json(payload(await findByToken(env, token), false));
  }

  const name = str(body.name, 'name', { max: 120, label: 'Le nom' }) || null;
  const now = Date.now();
  const res = await env.DB.prepare(
    `UPDATE quotes SET status = 'refused', decided_online_at = ?, decided_by_name = ?, client_message = ?, follow_up_on = NULL, updated_at = ?
     WHERE id = ? AND status = 'pending'`
  ).bind(now, name, message, now, row.id).run();
  if (!res.meta || res.meta.changes !== 1) throw new HttpError(409, 'already_decided', 'Cette soumission a déjà reçu une réponse.');
  await track(env, 'quote_refused_online', row.user_id);
  return json(payload(await findByToken(env, token), false));
}

/** /s/:jeton → page statique de la soumission, jamais indexée ni mise en cache. */
export async function servePublicPage(request, env) {
  const res = await env.ASSETS.fetch(new Request(new URL('/soumission', request.url), { headers: request.headers }));
  const out = new Response(res.body, res);
  out.headers.set('cache-control', 'no-store');
  out.headers.set('x-robots-tag', 'noindex, nofollow');
  out.headers.set('referrer-policy', 'no-referrer');
  out.headers.set('x-content-type-options', 'nosniff');
  out.headers.set('x-frame-options', 'DENY');
  out.headers.set('content-security-policy',
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  return out;
}
