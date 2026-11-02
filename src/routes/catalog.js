// Bibliothèque : articles (prix de vente + coût privé) et forfaits (groupes de lignes) réutilisables.
import { HttpError, json, readJson } from '../lib/http.js';
import { newId } from '../lib/crypto.js';
import { requireUser } from '../lib/session.js';
import { assertCanWrite, track } from '../lib/guards.js';
import { catalogToJson, cleanCatalog, str } from '../lib/validate.js';

const MAX_PER_USER = 2000;
const COLS = ['kind', 'name', 'category', 'unit', 'price_cents', 'cost_cents', 'lines_json'];

async function getOwned(env, userId, id) {
  const row = await env.DB.prepare('SELECT * FROM catalog WHERE id = ? AND user_id = ?').bind(id, userId).first();
  if (!row) throw new HttpError(404, 'not_found', 'Article introuvable.');
  return row;
}

export async function listCatalog(request, env) {
  const user = await requireUser(env, request);
  const { results } = await env.DB.prepare(
    'SELECT * FROM catalog WHERE user_id = ? ORDER BY use_count DESC, name COLLATE NOCASE ASC LIMIT ?'
  ).bind(user.id, MAX_PER_USER).all();
  return json({ catalog: results.map(catalogToJson) });
}

export async function createCatalog(request, env) {
  const user = await requireUser(env, request);
  assertCanWrite(user, env);
  const c = cleanCatalog(await readJson(request, 60_000));
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM catalog WHERE user_id = ?').bind(user.id).first();
  if (count && count.n >= MAX_PER_USER) throw new HttpError(409, 'quota', 'Bibliothèque pleine (2000 éléments). Fais du ménage ou écris-nous.');
  const id = newId();
  const now = Date.now();
  const cols = ['id', 'user_id', ...COLS, 'price_updated_at', 'created_at', 'updated_at'];
  await env.DB.prepare(`INSERT INTO catalog (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .bind(id, user.id, ...COLS.map((k) => c[k] ?? null), now, now, now).run();
  await track(env, c.kind === 'package' ? 'package_created' : 'catalog_item_created', user.id);
  return json({ item: catalogToJson(await getOwned(env, user.id, id)) }, 201);
}

export async function updateCatalog(request, env, id) {
  const user = await requireUser(env, request);
  assertCanWrite(user, env);
  const before = await getOwned(env, user.id, id);
  const c = cleanCatalog(await readJson(request, 60_000));
  if (c.kind !== (before.kind === 'package' ? 'package' : 'item')) {
    throw new HttpError(400, 'validation_error', 'Un article ne peut pas devenir un forfait.', { field: 'kind' });
  }
  const now = Date.now();
  const priceChanged = before.price_cents !== c.price_cents || before.cost_cents !== c.cost_cents || before.lines_json !== c.lines_json;
  await env.DB.prepare(`UPDATE catalog SET ${COLS.map((k) => `${k} = ?`).join(', ')}, price_updated_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
    .bind(...COLS.map((k) => c[k] ?? null), priceChanged ? now : (before.price_updated_at || before.created_at), now, id, user.id).run();
  return json({ item: catalogToJson(await getOwned(env, user.id, id)) });
}

export async function deleteCatalog(request, env, id) {
  const user = await requireUser(env, request);
  assertCanWrite(user, env);
  const res = await env.DB.prepare('DELETE FROM catalog WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  if (!res.meta || res.meta.changes === 0) throw new HttpError(404, 'not_found', 'Article introuvable.');
  return json({ ok: true });
}

/** Utilisation dans une soumission : les éléments les plus utilisés remontent en tête de liste. */
export async function useCatalog(request, env, id) {
  const user = await requireUser(env, request);
  assertCanWrite(user, env);
  const res = await env.DB.prepare('UPDATE catalog SET use_count = use_count + 1, last_used_at = ? WHERE id = ? AND user_id = ?')
    .bind(Date.now(), id, user.id).run();
  if (!res.meta || res.meta.changes === 0) throw new HttpError(404, 'not_found', 'Article introuvable.');
  return json({ ok: true });
}

/**
 * Ajustement en masse : « Bois +8 % ». Prix de vente et coût bougent ensemble, la marge en % reste la même.
 * percent : de -50 à +100, au dixième près. category vide = toutes les catégories.
 */
export async function adjustPrices(request, env) {
  const user = await requireUser(env, request);
  assertCanWrite(user, env);
  const body = await readJson(request, 2_000);
  const category = str(body.category, 'category', { max: 40, label: 'La catégorie' });
  const raw = typeof body.percent === 'string' ? body.percent.replace(/[\s%]/g, '').replace(',', '.') : body.percent;
  const pct = Number(raw);
  if (raw === '' || raw === null || raw === undefined || !Number.isFinite(pct) || pct < -50 || pct > 100 || pct === 0
    || Math.round(pct * 10) !== pct * 10) {
    throw new HttpError(400, 'validation_error', 'Pourcentage : entre -50 et +100, sans 0.', { field: 'percent' });
  }
  const factor = 1000 + Math.round(pct * 10); // en millièmes
  const now = Date.now();
  const where = category ? 'user_id = ? AND kind = ? AND category = ?' : 'user_id = ? AND kind = ?';
  const args = category ? [user.id, 'item', category] : [user.id, 'item'];
  const res = await env.DB.prepare(
    `UPDATE catalog SET price_cents = CAST((price_cents * ? + 500) / 1000 AS INTEGER),
       cost_cents = CASE WHEN cost_cents IS NULL THEN NULL ELSE CAST((cost_cents * ? + 500) / 1000 AS INTEGER) END,
       price_updated_at = ?, updated_at = ?
     WHERE ${where}`
  ).bind(factor, factor, now, now, ...args).run();
  await track(env, 'catalog_adjusted', user.id);
  return json({ updated: res.meta ? res.meta.changes : 0 });
}
