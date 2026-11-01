export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...BASE_HEADERS, ...headers } });
}

export function errorResponse(err) {
  if (err instanceof HttpError) {
    return json({ error: { code: err.code, message: err.message, ...err.extra } }, err.status);
  }
  console.error('Unhandled error', err && err.stack ? err.stack : err);
  return json({ error: { code: 'server_error', message: 'Erreur inattendue. Réessaie dans un instant.' } }, 500);
}

export async function readJson(request, maxBytes = 1_000_000) {
  const type = request.headers.get('content-type') || '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Format de requête invalide.');
  }
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'payload_too_large', 'Requête trop volumineuse.');
  if (!text) return {};
  try {
    const data = JSON.parse(text);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data;
  } catch {
    throw new HttpError(400, 'invalid_json', 'Requête mal formée.');
  }
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function buildCookie(name, value, { maxAge, secure }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function isSecure(request) {
  return new URL(request.url).protocol === 'https:';
}

/** Protection CSRF : toute écriture doit venir de notre propre origine. */
export function assertSameOrigin(request, env) {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  const origin = request.headers.get('origin');
  const own = new URL(request.url).origin;
  const allowed = new Set([own]);
  if (env.APP_URL) {
    try { allowed.add(new URL(env.APP_URL).origin); } catch { /* ignore */ }
  }
  if (origin && allowed.has(origin)) return;
  if (!origin && request.headers.get('sec-fetch-site') === 'same-origin') return;
  throw new HttpError(403, 'bad_origin', 'Requête refusée.');
}

export function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
}

export function appOrigin(request, env) {
  if (env.APP_URL) {
    try { return new URL(env.APP_URL).origin; } catch { /* fallthrough */ }
  }
  return new URL(request.url).origin;
}
