// Fiches clients dérivées des soumissions (aucune table séparée, fonctionne hors ligne).
// Pur : aucune dépendance DOM, testé par scripts/clients-test.mjs.

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Regroupe par courriel (sinon par nom). La coordonnée la plus récente gagne. */
export function clientsOf(quotes) {
  const sorted = [...quotes].sort((a, b) => String(b.sentOn || '').localeCompare(String(a.sentOn || '')));
  const map = new Map();
  for (const q of sorted) {
    const email = (q.clientEmail || '').trim().toLowerCase();
    const key = email || `nom:${fold(q.client)}`;
    if (key === 'nom:') continue;
    let c = map.get(key);
    if (!c) {
      c = { key, name: q.client || '', email: q.clientEmail || '', phone: q.clientPhone || '', count: 0, accepted: 0, pending: 0, lastSent: q.sentOn || '' };
      map.set(key, c);
    }
    c.count += 1;
    if (q.status === 'accepted') c.accepted += Number(q.amount) || 0;
    if (q.status === 'pending') c.pending += 1;
    if (!c.phone && q.clientPhone) c.phone = q.clientPhone;
  }
  return [...map.values()];
}
