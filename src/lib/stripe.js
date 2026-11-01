import { HttpError } from './http.js';
import { hmacSha256Hex, timingSafeEqualStr } from './crypto.js';

export function billingEnabled(env) {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_ID);
}

/** {a:{b:[{c:1}]}} → [['a[b][0][c]', '1']] (format attendu par l'API Stripe) */
export function flatten(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') flatten(v, key, out);
    else out.push([key, String(v)]);
  }
  return out;
}

export async function stripeApi(env, method, path, params) {
  const url = new URL(`https://api.stripe.com/v1${path}`);
  const init = {
    method,
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  };
  if (params) {
    const body = new URLSearchParams(flatten(params));
    if (method === 'GET') url.search = body.toString();
    else {
      init.body = body.toString();
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }
  const res = await fetch(url, init);
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    console.error('Stripe API error', res.status, data && data.error);
    throw new HttpError(502, 'stripe_error', 'Le service de paiement ne répond pas correctement. Réessaie dans un instant.');
  }
  return data;
}

/** Vérifie l'en-tête Stripe-Signature (schéma v1, HMAC-SHA256). */
export async function verifyStripeSignature(payload, header, secret, toleranceSeconds = 300, now = Date.now()) {
  if (!header || !secret) return false;
  let timestamp = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') timestamp = Number(v);
    else if (k === 'v1' && v) signatures.push(v);
  }
  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
  return signatures.some((sig) => timingSafeEqualStr(sig, expected));
}

/** Statut Stripe → statut interne. */
export function mapSubscriptionStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'incomplete':
      return null; // paiement initial pas encore confirmé : on ne change rien
    default:
      return 'canceled'; // canceled, incomplete_expired, paused
  }
}
