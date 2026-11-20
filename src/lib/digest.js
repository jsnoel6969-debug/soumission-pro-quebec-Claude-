// Courriel quotidien à l'ENTREPRENEUR (jamais au client) : ses relances du jour et en retard.
// Conforme à la règle produit : l'app n'envoie rien aux clients.
import { todayToronto } from './dates.js';
import { mailEnabled, sendMail } from './mail.js';

/** Regroupe les lignes SQL par entrepreneur. Pur : testable sans base de données. */
export function groupDueFollowUps(rows) {
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) {
      byUser.set(r.user_id, { userId: r.user_id, email: r.email, name: r.display_name, items: [] });
    }
    byUser.get(r.user_id).items.push({ client: r.client, project: r.project, followUpOn: r.follow_up_on });
  }
  return [...byUser.values()];
}

/** Texte du courriel. Les en retard sont listés en premier. */
export function digestText(name, items, today) {
  const late = items.filter((i) => i.followUpOn < today);
  const due = items.filter((i) => i.followUpOn === today);
  const line = (i) => `- ${i.client} : ${i.project} (relance prévue le ${i.followUpOn})`;
  const parts = [`Bonjour${name ? ` ${name}` : ''},`, '', `Tu as ${items.length} relance(s) à faire aujourd'hui ou en retard.`, ''];
  if (late.length) parts.push('En retard :', ...late.map(line), '');
  if (due.length) parts.push("Aujourd'hui :", ...due.map(line), '');
  parts.push('Ouvre Soumission Pro pour copier le message de relance et l\'envoyer toi-même.', '', '— Soumission Pro');
  return parts.join('\n');
}

/** Envoie un courriel par entrepreneur ayant au moins une relance due. */
export async function sendFollowUpDigests(env, now = new Date()) {
  if (!mailEnabled(env)) return { sent: 0, reason: 'mail_disabled' };
  const today = todayToronto(now);
  const { results } = await env.DB.prepare(
    `SELECT q.user_id, q.client, q.project, q.follow_up_on, u.email, u.display_name
       FROM quotes q JOIN users u ON u.id = q.user_id
      WHERE q.status = 'pending'
        AND q.follow_up_on IS NOT NULL
        AND q.follow_up_on <= ?
        AND u.plan_status != 'canceled'
      ORDER BY q.user_id, q.follow_up_on`,
  ).bind(today).all();

  let sent = 0;
  for (const d of groupDueFollowUps(results || [])) {
    const ok = await sendMail(env, {
      to: d.email,
      subject: `Soumission Pro — ${d.items.length} relance(s) à faire`,
      text: digestText(d.name, d.items, today),
    });
    if (ok) sent += 1;
  }
  return { sent };
}
