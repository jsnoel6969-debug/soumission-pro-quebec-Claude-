// Calculs d'argent partagés par le navigateur et le serveur (même fichier, mêmes résultats).
// Montants en cents entiers, quantités en millièmes entiers : aucun arrondi flottant cumulé.

export const GST_PPM = 50_000;  // TPS 5 %
export const QST_PPM = 99_750;  // TVQ 9,975 %
export const MAX_CENTS = 10_000_000_000; // 100 M$

/** Montant en dollars → cents. « 8 450,50 », « 8450.5 », 8450.5 → 845050. Invalide → null. */
export function toCents(value) {
  let n = value;
  if (typeof n === 'string') {
    // Virgule suivie de 1 ou 2 chiffres = décimale ; sinon séparateur de milliers.
    const s = n.replace(/[\s  $]/g, '').replace(/,(?=\d{1,2}$)/, '.').replace(/,/g, '');
    n = /^(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
  }
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  const cents = Math.round(n * 100);
  return cents <= MAX_CENTS ? cents : null;
}

/** Quantité → millièmes. « 2,5 » → 2500. Doit être > 0. Invalide → null. */
export function toQtyMilli(value) {
  let n = value;
  if (typeof n === 'string') {
    let s = n.replace(/[\s  ]/g, '');
    s = s.includes(',') && s.includes('.') ? s.replace(/,/g, '') : s.replace(',', '.');
    n = /^(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
  }
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  const milli = Math.round(n * 1000);
  return milli > 0 && milli <= 100_000_000 ? milli : null;
}

export function lineCents(qtyMilli, unitCents) {
  return Math.round((qtyMilli * unitCents) / 1000);
}

/**
 * lines : [{ qtyMilli, unitCents, excluded? }] déjà validées. Une ligne « excluded » (option non choisie)
 * garde son montant de ligne mais ne compte pas dans le sous-total.
 * TPS et TVQ se calculent chacune sur le montant après rabais (la TVQ ne s'applique pas sur la TPS).
 */
export function computeTotals(lines, discountCents = 0, taxes = false) {
  const lineTotals = lines.map((l) => lineCents(l.qtyMilli, l.unitCents));
  const subtotalCents = lineTotals.reduce((sum, cents, i) => (lines[i].excluded ? sum : sum + cents), 0);
  const optionsCents = lineTotals.reduce((sum, cents, i) => (lines[i].excluded ? sum + cents : sum), 0);
  if (discountCents < 0 || discountCents > subtotalCents) return { error: 'discount' };
  const taxable = subtotalCents - discountCents;
  const gstCents = taxes ? Math.round((taxable * GST_PPM) / 1_000_000) : 0;
  const qstCents = taxes ? Math.round((taxable * QST_PPM) / 1_000_000) : 0;
  const totalCents = taxable + gstCents + qstCents;
  if (totalCents > MAX_CENTS) return { error: 'total' };
  return { lineTotals, subtotalCents, optionsCents, discountCents, gstCents, qstCents, totalCents };
}
