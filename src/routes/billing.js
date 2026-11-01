import { HttpError, json, appOrigin } from '../lib/http.js';
import { requireUser } from '../lib/session.js';
import { track } from '../lib/guards.js';
import { billingEnabled, mapSubscriptionStatus, stripeApi, verifyStripeSignature } from '../lib/stripe.js';

export async function checkout(request, env) {
  const user = await requireUser(env, request);
  if (user.plan_status === 'active') throw new HttpError(409, 'already_active', 'Ton abonnement est déjà actif.');

  if (!billingEnabled(env)) {
    // Paiement pas encore ouvert : on enregistre l'intention d'achat (signal de demande réel).
    if (!user.billing_interest_at) {
      await env.DB.prepare('UPDATE users SET billing_interest_at = ? WHERE id = ?').bind(Date.now(), user.id).run();
      await track(env, 'billing_interest', user.id);
    }
    return json({ interestRecorded: true });
  }

  const origin = appOrigin(request, env);
  const tax = env.STRIPE_AUTOMATIC_TAX === 'true';
  const params = {
    mode: 'subscription',
    line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
    success_url: `${origin}/app?facturation=ok`,
    cancel_url: `${origin}/app?facturation=annule`,
    client_reference_id: user.id,
    locale: 'fr-CA',
    allow_promotion_codes: 'true',
    metadata: { user_id: user.id },
    subscription_data: { metadata: { user_id: user.id } },
  };
  if (user.stripe_customer_id) params.customer = user.stripe_customer_id;
  else params.customer_email = user.email;
  if (tax) {
    params.automatic_tax = { enabled: 'true' };
    params.billing_address_collection = 'required';
    if (user.stripe_customer_id) params.customer_update = { address: 'auto', name: 'auto' };
  }
  const session = await stripeApi(env, 'POST', '/checkout/sessions', params);
  await track(env, 'checkout_started', user.id);
  return json({ url: session.url });
}

export async function portal(request, env) {
  const user = await requireUser(env, request);
  if (!billingEnabled(env) || !user.stripe_customer_id) {
    throw new HttpError(400, 'no_billing', 'Aucun abonnement à gérer pour ce compte.');
  }
  const session = await stripeApi(env, 'POST', '/billing_portal/sessions', {
    customer: user.stripe_customer_id,
    return_url: `${appOrigin(request, env)}/app`,
    locale: 'fr-CA',
  });
  return json({ url: session.url });
}

async function findUserForSubscription(env, sub) {
  const byMeta = sub.metadata && sub.metadata.user_id;
  if (byMeta) {
    const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(byMeta).first();
    if (u) return u;
  }
  const bySub = await env.DB.prepare('SELECT * FROM users WHERE stripe_subscription_id = ?').bind(sub.id).first();
  if (bySub) return bySub;
  if (sub.customer) {
    return env.DB.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').bind(sub.customer).first();
  }
  return null;
}

/** Relit l'abonnement chez Stripe (source de vérité) — insensible à l'ordre des webhooks. */
async function syncSubscription(env, subscriptionId, fallbackUserId = null) {
  const sub = await stripeApi(env, 'GET', `/subscriptions/${encodeURIComponent(subscriptionId)}`);
  let user = await findUserForSubscription(env, sub);
  if (!user && fallbackUserId) {
    user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(fallbackUserId).first();
  }
  if (!user) {
    console.warn('Webhook: aucun utilisateur pour', subscriptionId);
    return;
  }
  const mapped = mapSubscriptionStatus(sub.status);
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer && sub.customer.id;
  if (!mapped) {
    await env.DB.prepare('UPDATE users SET stripe_customer_id = COALESCE(stripe_customer_id, ?) WHERE id = ?')
      .bind(customerId || null, user.id).run();
    return;
  }
  // Un ancien abonnement annulé ne doit pas écraser un abonnement actif plus récent.
  if (mapped === 'canceled' && user.stripe_subscription_id && user.stripe_subscription_id !== sub.id) return;

  await env.DB.prepare(
    'UPDATE users SET plan_status = ?, stripe_subscription_id = ?, stripe_customer_id = ? WHERE id = ?'
  ).bind(mapped, sub.id, customerId || user.stripe_customer_id || null, user.id).run();

  if (mapped === 'active' && user.plan_status !== 'active') await track(env, 'subscription_active', user.id);
  if (mapped === 'canceled' && user.plan_status !== 'canceled') await track(env, 'subscription_canceled', user.id);
}

export async function webhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_SECRET_KEY) {
    throw new HttpError(404, 'not_found', 'Introuvable.');
  }
  const payload = await request.text();
  const ok = await verifyStripeSignature(payload, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET);
  if (!ok) throw new HttpError(400, 'bad_signature', 'Signature invalide.');

  let event;
  try { event = JSON.parse(payload); } catch { throw new HttpError(400, 'invalid_json', 'Requête mal formée.'); }

  const seen = await env.DB.prepare('SELECT id FROM stripe_events WHERE id = ?').bind(event.id).first();
  if (seen) return json({ received: true, duplicate: true });

  const obj = event.data && event.data.object ? event.data.object : {};
  switch (event.type) {
    case 'checkout.session.completed':
      if (obj.mode === 'subscription' && obj.subscription) {
        const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id;
        await syncSubscription(env, subId, obj.client_reference_id || (obj.metadata && obj.metadata.user_id) || null);
      }
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await syncSubscription(env, obj.id);
      break;
    case 'invoice.payment_failed':
    case 'invoice.paid':
      if (obj.subscription) {
        await syncSubscription(env, typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id);
      }
      break;
    default:
      break; // événements ignorés
  }

  // Enregistré seulement après traitement réussi : en cas d'erreur, Stripe réessaie.
  await env.DB.prepare('INSERT OR IGNORE INTO stripe_events (id, created_at) VALUES (?, ?)').bind(event.id, Date.now()).run();
  return json({ received: true });
}
