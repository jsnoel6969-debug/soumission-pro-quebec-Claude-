/** Envoi transactionnel optionnel via Resend. Sans clé : retourne false (lien généré par l'admin). */
export function mailEnabled(env) {
  return Boolean(env.RESEND_API_KEY && env.MAIL_FROM);
}

export async function sendMail(env, { to, subject, text }) {
  if (!mailEnabled(env)) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text }),
    });
    if (!res.ok) {
      console.error('Mail send failed', res.status, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (err) {
    console.error('Mail send error', err);
    return false;
  }
}
