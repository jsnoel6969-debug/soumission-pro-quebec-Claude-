import { HttpError, buildCookie, isSecure, parseCookies } from './http.js';
import { randomToken, sha256Hex } from './crypto.js';

export const SESSION_COOKIE = 'sp_session';
const SESSION_DAYS = 30;
const DAY = 86_400_000;

export async function createSession(env, request, userId) {
  const token = randomToken(32);
  const now = Date.now();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, now, now + SESSION_DAYS * DAY)
    .run();
  await env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now, userId).run();
  return buildCookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86_400, secure: isSecure(request) });
}

export function clearSessionCookie(request) {
  return buildCookie(SESSION_COOKIE, '', { maxAge: 0, secure: isSecure(request) });
}

async function tokenHashFrom(request) {
  const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  if (!token || token.length > 200) return null;
  return sha256Hex(token);
}

export async function getSessionUser(env, request) {
  const hash = await tokenHashFrom(request);
  if (!hash) return null;
  const user = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(hash, Date.now()).first();
  return user || null;
}

export async function requireUser(env, request) {
  const user = await getSessionUser(env, request);
  if (!user) throw new HttpError(401, 'unauthenticated', 'Session expirée. Reconnecte-toi.');
  return user;
}

export async function destroySession(env, request) {
  const hash = await tokenHashFrom(request);
  if (hash) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
}

export async function destroyAllSessions(env, userId) {
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
}
