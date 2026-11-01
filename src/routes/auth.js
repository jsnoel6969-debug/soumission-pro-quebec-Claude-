import { HttpError, json, readJson, clientIp, appOrigin } from '../lib/http.js';
import { hashPassword, verifyPassword, burnPasswordCheck, newId, randomToken, sha256Hex } from '../lib/crypto.js';
import { createSession, clearSessionCookie, destroySession, destroyAllSessions, requireUser } from '../lib/session.js';
import { entitlement, publicUser, rateLimit, track } from '../lib/guards.js';
import { cleanBusiness, email as vEmail, password as vPassword, str } from '../lib/validate.js';
import { billingEnabled, stripeApi } from '../lib/stripe.js';
import { mailEnabled, sendMail } from '../lib/mail.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

function trialDays(env) {
  const n = Number(env.TRIAL_DAYS);
  return Number.isInteger(n) && n > 0 && n <= 90 ? n : 14;
}

export function mePayload(env, user) {
  return {
    user: publicUser(user),
    entitlement: entitlement(user, { billingOn: billingEnabled(env) }),
    billing: { enabled: billingEnabled(env) },
  };
}

export async function signup(request, env) {
  await rateLimit(env, `signup:${clientIp(request)}`, 10, 3600);
  const body = await readJson(request, 10_000);
  const email = vEmail(body.email);
  const password = vPassword(body.password);
  const displayName = str(body.displayName, 'displayName', { max: 80, required: true, label: 'Ton prénom' });
  const company = str(body.company, 'company', { max: 120, label: "L'entreprise" });
  if (body.acceptTerms !== true) {
    throw new HttpError(400, 'validation_error', 'Tu dois accepter les conditions et la politique de confidentialité.', { field: 'acceptTerms' });
  }

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) throw new HttpError(409, 'email_taken', 'Un compte existe déjà avec ce courriel. Connecte-toi.', { field: 'email' });

  const now = Date.now();
  const id = newId();
  try {
    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, display_name, company, created_at, trial_ends_at, plan_status, terms_accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'trial', ?)`
    ).bind(id, email, await hashPassword(password), displayName, company || null, now, now + trialDays(env) * DAY, now).run();
  } catch (err) {
    if (String(err && err.message).includes('UNIQUE')) {
      throw new HttpError(409, 'email_taken', 'Un compte existe déjà avec ce courriel. Connecte-toi.', { field: 'email' });
    }
    throw err;
  }

  const cookie = await createSession(env, request, id);
  await track(env, 'signup', id);
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  return json(mePayload(env, user), 201, { 'set-cookie': cookie });
}

export async function login(request, env) {
  const body = await readJson(request, 10_000);
  const email = vEmail(body.email);
  const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
  await rateLimit(env, `login-ip:${clientIp(request)}`, 30, 900);
  await rateLimit(env, `login:${email}`, 10, 900);

  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!user) {
    await burnPasswordCheck(password);
    throw new HttpError(401, 'invalid_credentials', 'Courriel ou mot de passe incorrect.');
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    throw new HttpError(401, 'invalid_credentials', 'Courriel ou mot de passe incorrect.');
  }
  const cookie = await createSession(env, request, user.id);
  await track(env, 'login', user.id);
  return json(mePayload(env, user), 200, { 'set-cookie': cookie });
}

export async function logout(request, env) {
  await destroySession(env, request);
  return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie(request) });
}

export async function me(request, env) {
  const user = await requireUser(env, request);
  return json(mePayload(env, user));
}

export async function updateMe(request, env) {
  const user = await requireUser(env, request);
  const body = await readJson(request, 20_000);
  const displayName = str(body.displayName, 'displayName', { max: 80, required: true, label: 'Ton prénom' });
  const company = str(body.company, 'company', { max: 120, label: "L'entreprise" });
  const sets = ['display_name = ?', 'company = ?'];
  const values = [displayName, company || null];
  // Les champs d'entreprise sont mis à jour seulement s'ils sont envoyés (le formulaire de profil simple reste valide).
  if (body.business && typeof body.business === 'object') {
    const b = cleanBusiness(body.business);
    for (const [col, val] of Object.entries(b)) { sets.push(`${col} = ?`); values.push(val); }
  }
  await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...values, user.id).run();
  const fresh = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
  return json(mePayload(env, fresh));
}

export async function createResetToken(env, userId, ttlMs) {
  const token = randomToken(32);
  await env.DB.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(token), userId, Date.now() + ttlMs).run();
  return token;
}

export async function requestReset(request, env) {
  await rateLimit(env, `reset:${clientIp(request)}`, 5, 3600);
  const body = await readJson(request, 10_000);
  const email = vEmail(body.email);
  const user = await env.DB.prepare('SELECT id, email FROM users WHERE email = ?').bind(email).first();
  if (user) {
    await track(env, 'reset_requested', user.id);
    if (mailEnabled(env)) {
      const token = await createResetToken(env, user.id, HOUR);
      const link = `${appOrigin(request, env)}/reinitialiser?token=${encodeURIComponent(token)}`;
      await sendMail(env, {
        to: user.email,
        subject: 'Soumission Pro — réinitialiser ton mot de passe',
        text: `Bonjour,\n\nPour choisir un nouveau mot de passe, ouvre ce lien (valide 1 heure) :\n${link}\n\nSi tu n'as rien demandé, ignore ce courriel.\n\n— Soumission Pro`,
      });
    }
  }
  // Même réponse que le compte existe ou non (pas d'énumération).
  return json({ ok: true, emailDelivery: mailEnabled(env), supportEmail: env.SUPPORT_EMAIL || '' });
}

export async function confirmReset(request, env) {
  await rateLimit(env, `reset-confirm:${clientIp(request)}`, 20, 3600);
  const body = await readJson(request, 10_000);
  const token = typeof body.token === 'string' ? body.token.slice(0, 200) : '';
  const password = vPassword(body.password);
  if (!token) throw new HttpError(400, 'invalid_token', 'Lien invalide ou expiré.');
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    'SELECT user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?'
  ).bind(hash, Date.now()).first();
  if (!row) throw new HttpError(400, 'invalid_token', 'Lien invalide ou expiré. Demande un nouveau lien.');

  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(password), row.user_id),
    env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?').bind(Date.now(), hash),
  ]);
  await destroyAllSessions(env, row.user_id);
  const cookie = await createSession(env, request, row.user_id);
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(row.user_id).first();
  return json(mePayload(env, user), 200, { 'set-cookie': cookie });
}

export async function deleteAccount(request, env) {
  const user = await requireUser(env, request);
  const body = await readJson(request, 10_000);
  const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
  await rateLimit(env, `delete:${user.id}`, 5, 900);
  if (!(await verifyPassword(password, user.password_hash))) {
    throw new HttpError(401, 'invalid_credentials', 'Mot de passe incorrect.', { field: 'password' });
  }
  // Arrêter la facturation avant d'effacer le compte.
  if (user.stripe_subscription_id && billingEnabled(env) && user.plan_status !== 'canceled') {
    await stripeApi(env, 'DELETE', `/subscriptions/${encodeURIComponent(user.stripe_subscription_id)}`);
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM invoices WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM quotes WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(user.id),
    env.DB.prepare('UPDATE events SET user_id = NULL WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
  ]);
  return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie(request) });
}
