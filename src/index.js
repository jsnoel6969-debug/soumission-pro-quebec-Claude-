import { HttpError, assertSameOrigin, errorResponse, json } from './lib/http.js';
import { billingEnabled } from './lib/stripe.js';
import * as auth from './routes/auth.js';
import * as quotes from './routes/quotes.js';
import * as billing from './routes/billing.js';
import * as admin from './routes/admin.js';
import * as pub from './routes/public.js';

/** Config publique lue par le site (prix, essai, places fondateur réelles). */
async function publicConfig(request, env) {
  const seats = Number(env.FOUNDER_SEATS) || 0;
  let seatsLeft = null;
  if (billingEnabled(env) && seats > 0) {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE plan_status IN ('active','past_due')").first();
    seatsLeft = Math.max(0, seats - (row ? row.n : 0));
  }
  return json({
    trialDays: Number(env.TRIAL_DAYS) || 14,
    priceMonthly: (Number(env.PRICE_MONTHLY_CENTS) || 0) / 100,
    founderSeats: seats,
    founderSeatsLeft: seatsLeft,
    billingEnabled: billingEnabled(env),
    supportEmail: env.SUPPORT_EMAIL || '',
    legalName: env.LEGAL_NAME || '',
  }, 200, { 'cache-control': 'public, max-age=60' });
}

const ID = '([0-9a-fA-F-]{36})';
const routes = [
  ['GET', /^\/api\/health$/, () => json({ ok: true })],
  ['GET', /^\/api\/public\/config$/, publicConfig],
  ['POST', /^\/api\/auth\/signup$/, auth.signup],
  ['POST', /^\/api\/auth\/login$/, auth.login],
  ['POST', /^\/api\/auth\/logout$/, auth.logout],
  ['POST', /^\/api\/auth\/reset\/request$/, auth.requestReset],
  ['POST', /^\/api\/auth\/reset\/confirm$/, auth.confirmReset],
  ['GET', /^\/api\/me$/, auth.me],
  ['PATCH', /^\/api\/me$/, auth.updateMe],
  ['DELETE', /^\/api\/me$/, auth.deleteAccount],
  ['GET', /^\/api\/quotes$/, quotes.listQuotes],
  ['POST', /^\/api\/quotes$/, quotes.createQuote],
  ['POST', /^\/api\/quotes\/import$/, quotes.importQuotes],
  ['PUT', new RegExp(`^/api/quotes/${ID}$`), quotes.updateQuote],
  ['DELETE', new RegExp(`^/api/quotes/${ID}$`), quotes.deleteQuote],
  ['POST', new RegExp(`^/api/quotes/${ID}/follow-up$`), quotes.markFollowUp],
  ['POST', new RegExp(`^/api/quotes/${ID}/share$`), quotes.shareQuote],
  ['DELETE', new RegExp(`^/api/quotes/${ID}/share$`), quotes.unshareQuote],
  ['GET', /^\/api\/public\/quotes\/([A-Za-z0-9_-]{20,64})$/, pub.getPublicQuote],
  ['POST', /^\/api\/public\/quotes\/([A-Za-z0-9_-]{20,64})\/decision$/, pub.decidePublicQuote],
  ['POST', /^\/api\/billing\/checkout$/, billing.checkout],
  ['POST', /^\/api\/billing\/portal$/, billing.portal],
  ['POST', /^\/api\/stripe\/webhook$/, billing.webhook],
  ['GET', /^\/api\/admin\/metrics$/, admin.metrics],
  ['GET', /^\/api\/admin\/users$/, admin.listUsers],
  ['POST', /^\/api\/admin\/reset-link$/, admin.resetLink],
];

// Ces routes s'authentifient autrement (signature Stripe / jeton admin) : pas de contrôle d'origine.
const ORIGIN_EXEMPT = /^\/api\/(stripe\/webhook|admin\/)/;

async function handleApi(request, env, url) {
  let methodMismatch = false;
  for (const [method, pattern, handler] of routes) {
    const match = url.pathname.match(pattern);
    if (!match) continue;
    if (method !== request.method) { methodMismatch = true; continue; }
    if (!ORIGIN_EXEMPT.test(url.pathname)) assertSameOrigin(request, env);
    return handler(request, env, ...match.slice(1));
  }
  if (methodMismatch) throw new HttpError(405, 'method_not_allowed', 'Méthode non permise.');
  throw new HttpError(404, 'not_found', 'Introuvable.');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (/^\/s\/[A-Za-z0-9_-]{20,64}$/.test(url.pathname) && (request.method === 'GET' || request.method === 'HEAD')) {
      return pub.servePublicPage(request, env);
    }
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url);
    } catch (err) {
      return errorResponse(err);
    }
  },
};
