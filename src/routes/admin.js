import { HttpError, json, readJson, appOrigin } from '../lib/http.js';
import { timingSafeEqualStr } from '../lib/crypto.js';
import { email as vEmail } from '../lib/validate.js';
import { billingEnabled } from '../lib/stripe.js';
import { createResetToken } from './auth.js';

const DAY = 86_400_000;

function requireAdmin(request, env) {
  // Sans ADMIN_TOKEN configuré, l'admin n'existe pas.
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 24) throw new HttpError(404, 'not_found', 'Introuvable.');
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!timingSafeEqualStr(token, env.ADMIN_TOKEN)) throw new HttpError(404, 'not_found', 'Introuvable.');
}

/** Tableau de bord de l'entonnoir : inscriptions → activation → paiement. */
export async function metrics(request, env) {
  requireAdmin(request, env);
  const now = Date.now();
  const d7 = now - 7 * DAY;
  const d30 = now - 30 * DAY;
  const one = (sql, ...args) => env.DB.prepare(sql).bind(...args).first();

  const [users, s7, s30, activated, plans, interest, quotes, pending, ev30] = await Promise.all([
    one('SELECT COUNT(*) AS n FROM users'),
    one('SELECT COUNT(*) AS n FROM users WHERE created_at > ?', d7),
    one('SELECT COUNT(*) AS n FROM users WHERE created_at > ?', d30),
    one('SELECT COUNT(DISTINCT user_id) AS n FROM quotes'),
    env.DB.prepare(
      `SELECT plan_status AS status, COUNT(*) AS n,
              SUM(CASE WHEN plan_status = 'trial' AND trial_ends_at <= ? THEN 1 ELSE 0 END) AS expired
       FROM users GROUP BY plan_status`
    ).bind(now).all(),
    one('SELECT COUNT(*) AS n FROM users WHERE billing_interest_at IS NOT NULL'),
    one('SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM quotes'),
    one(`SELECT COALESCE(SUM(amount_cents), 0) AS cents,
           (SELECT COUNT(*) FROM quotes WHERE items_json IS NOT NULL) AS detailed,
           (SELECT COUNT(*) FROM quotes WHERE shared_at IS NOT NULL) AS shared,
           (SELECT COUNT(*) FROM quotes WHERE view_count > 0) AS viewed,
           (SELECT COUNT(*) FROM quotes WHERE decided_online_at IS NOT NULL AND status = 'accepted') AS acceptedOnline
         FROM quotes WHERE status = 'pending'`),
    env.DB.prepare('SELECT name, COUNT(*) AS n FROM events WHERE created_at > ? GROUP BY name').bind(d30).all(),
  ]);

  const byPlan = { trial: 0, trial_expired: 0, active: 0, past_due: 0, canceled: 0 };
  for (const r of plans.results) {
    if (r.status === 'trial') {
      byPlan.trial_expired = r.expired || 0;
      byPlan.trial = r.n - byPlan.trial_expired;
    } else byPlan[r.status] = r.n;
  }
  const price = Number(env.PRICE_MONTHLY_CENTS) || 0;
  const paying = byPlan.active + byPlan.past_due;
  const events30d = Object.fromEntries(ev30.results.map((r) => [r.name, r.n]));

  return json({
    generatedAt: new Date(now).toISOString(),
    billingEnabled: billingEnabled(env),
    funnel: {
      users: users.n,
      signups7d: s7.n,
      signups30d: s30.n,
      activatedUsers: activated.n,
      activationRate: users.n ? Math.round((activated.n / users.n) * 1000) / 10 : 0,
      billingInterest: interest.n,
      paying,
      trialToPaid: users.n ? Math.round((paying / users.n) * 1000) / 10 : 0,
    },
    plans: byPlan,
    revenue: { mrrCents: paying * price, priceMonthlyCents: price },
    usage: {
      quotes: quotes.n, totalQuotedCents: quotes.cents, pendingValueCents: pending.cents,
      detailedQuotes: pending.detailed, sharedQuotes: pending.shared, viewedQuotes: pending.viewed, acceptedOnline: pending.acceptedOnline,
    },
    events30d,
  });
}

/** Liste des comptes récents — pour faire le suivi personnel des essais. */
export async function listUsers(request, env) {
  requireAdmin(request, env);
  const { results } = await env.DB.prepare(
    `SELECT u.email, u.display_name, u.company, u.plan_status, u.created_at, u.last_seen_at, u.trial_ends_at,
            u.billing_interest_at, (SELECT COUNT(*) FROM quotes q WHERE q.user_id = u.id) AS quotes
     FROM users u ORDER BY u.created_at DESC LIMIT 200`
  ).all();
  return json({ users: results });
}

/** Génère un lien de réinitialisation (24 h) quand aucun service courriel n'est branché. */
export async function resetLink(request, env) {
  requireAdmin(request, env);
  const body = await readJson(request, 2_000);
  const email = vEmail(body.email);
  const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (!user) throw new HttpError(404, 'not_found', 'Aucun compte avec ce courriel.');
  const token = await createResetToken(env, user.id, DAY);
  return json({ link: `${appOrigin(request, env)}/reinitialiser?token=${encodeURIComponent(token)}`, expiresInHours: 24 });
}
