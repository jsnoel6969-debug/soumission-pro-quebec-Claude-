import { billingEnabled } from './stripe.js';
import { HttpError } from './http.js';

const DAY = 86_400_000;

/** Ce que le compte a le droit de faire selon son statut d'abonnement. */
export function entitlement(user, { billingOn = true, now = Date.now() } = {}) {
  if (user.plan_status === 'active') return { state: 'active', canWrite: true };
  // Paiement en échec : Stripe réessaie pendant plusieurs jours, on ne coupe pas l'outil.
  if (user.plan_status === 'past_due') return { state: 'past_due', canWrite: true };
  if (user.plan_status === 'trial' && now < user.trial_ends_at) {
    return { state: 'trial', canWrite: true, trialDaysLeft: Math.max(1, Math.ceil((user.trial_ends_at - now) / DAY)) };
  }
  const state = user.plan_status === 'canceled' ? 'canceled' : 'trial_expired';
  // Tant que le paiement n'est pas ouvert, personne n'est bloqué : impossible de payer = pas de mur.
  if (state === 'trial_expired' && !billingOn) return { state, canWrite: true, grace: true };
  return { state, canWrite: false };
}

export function assertCanWrite(user, env) {
  const ent = entitlement(user, { billingOn: billingEnabled(env) });
  if (!ent.canWrite) {
    throw new HttpError(402, 'subscription_required',
      "Ton accès est en lecture seule. Active ton abonnement pour ajouter ou modifier des soumissions.");
  }
}

/** Limiteur simple à fenêtre fixe, stocké dans D1. */
export async function rateLimit(env, key, limit, windowSeconds) {
  const now = Date.now();
  const row = await env.DB.prepare('SELECT count, window_start FROM rate_limits WHERE key = ?').bind(key).first();
  if (!row || now - row.window_start > windowSeconds * 1000) {
    await env.DB.prepare(
      `INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start`
    ).bind(key, now).run();
    return;
  }
  if (row.count >= limit) {
    throw new HttpError(429, 'rate_limited', 'Trop de tentatives. Réessaie dans quelques minutes.');
  }
  await env.DB.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').bind(key).run();
}

export async function track(env, name, userId = null) {
  try {
    await env.DB.prepare('INSERT INTO events (user_id, name, created_at) VALUES (?, ?, ?)')
      .bind(userId, name, Date.now()).run();
  } catch (err) {
    console.error('track failed', name, err);
  }
}

export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name || '',
    company: user.company || '',
    planStatus: user.plan_status,
    trialEndsAt: user.trial_ends_at,
    hasBilling: Boolean(user.stripe_customer_id),
    billingInterest: Boolean(user.billing_interest_at),
    createdAt: user.created_at,
    business: {
      businessPhone: user.business_phone || '',
      businessEmail: user.business_email || '',
      businessAddress: user.business_address || '',
      rbqNumber: user.rbq_number || '',
      gstNumber: user.gst_number || '',
      qstNumber: user.qst_number || '',
      chargeTaxes: user.charge_taxes === undefined || user.charge_taxes === null ? true : Boolean(user.charge_taxes),
      defaultTerms: user.default_terms || '',
    },
  };
}
