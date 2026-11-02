// Dates au fuseau de Montréal (AAAA-MM-JJ) et jetons des liens client.
export const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

export function todayToronto(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
