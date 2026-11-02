// Éditeur de lignes réutilisable (soumissions et factures) : quantités, unités, prix, rabais, TPS/TVQ en direct.
// Soumissions : coût privé par ligne et marge en temps réel, jamais montrés au client.
import { h, money2 } from './utils.js';
import { toCents, toQtyMilli, computeTotals, lineCents } from './money.js';

export const decimalText = (n) => (n === null || n === undefined || n === '' ? '' : String(n).replace('.', ','));
export const emptyLine = () => ({ description: '', qty: '1', unit: '', unitPrice: '', unitCost: '' });
export const lineIsBlank = (l) => !String(l.description ?? '').trim() && !String(l.unitPrice ?? '').trim()
  && (!String(l.qty ?? '').trim() || String(l.qty).trim() === '1');

/** Lignes renvoyées par l'API (nombres) → lignes éditables (texte à la québécoise). */
export const toEditable = (items) => (items || []).map((it) => ({
  description: it.description, qty: decimalText(it.qty), unit: it.unit || '', unitPrice: decimalText(it.unitPrice),
  unitCost: it.unitCost === undefined || it.unitCost === null ? '' : decimalText(it.unitCost),
  optional: Boolean(it.optional), ...(it.itemId ? { itemId: it.itemId } : {}),
}));

const pctFmt = new Intl.NumberFormat('fr-CA', { style: 'percent', maximumFractionDigits: 0 });

/**
 * Marge des lignes incluses (les options non choisies ne comptent pas).
 * Retourne null si aucune ligne n'a de coût.
 */
export function marginOf(lines, discountCents) {
  let revenue = 0;
  let cost = 0;
  let withCost = 0;
  let without = 0;
  for (const l of lines) {
    if (l.excluded) continue;
    const qty = toQtyMilli(l.qty) ?? 0;
    const price = toCents(l.unitPrice) ?? 0;
    revenue += lineCents(qty, price);
    const c = String(l.unitCost ?? '').trim() === '' ? null : toCents(l.unitCost);
    if (c === null) { if (qty && price) without++; continue; }
    withCost++;
    cost += lineCents(qty, c);
  }
  if (!withCost) return null;
  const net = revenue - (discountCents || 0);
  return { profitCents: net - cost, pct: net > 0 ? (net - cost) / net : 0, linesWithoutCost: without };
}

/**
 * @param {object} o
 * @param {HTMLElement} o.listEl      conteneur des lignes
 * @param {HTMLElement} o.totalsEl    <dl> des totaux
 * @param {HTMLInputElement} o.discountInput
 * @param {HTMLInputElement} o.taxesInput  case à cocher TPS/TVQ
 * @param {string} o.idPrefix          préfixe des id (ex. « line » → line-qty-0)
 * @param {() => boolean} o.isWritable
 * @param {boolean} o.allowOptional    lignes « option » (soumissions)
 * @param {boolean} o.allowCost        coût privé par ligne (soumissions)
 * @param {() => boolean} o.showCost   afficher les champs de coût
 * @param {HTMLElement} o.marginEl     bandeau de marge (privé)
 * @param {() => number|null} o.marginFloor  plancher de marge du profil, en %
 * @param {() => {cents:number,label:string}|null} o.deduction  acompte déjà facturé (factures)
 */
export function createLineEditor({
  listEl, totalsEl, discountInput, taxesInput, idPrefix = 'line', isWritable = () => true, allowOptional = false,
  allowCost = false, showCost = () => false, marginEl = null, marginFloor = () => null, deduction = () => null,
}) {
  let lines = [];
  let active = true;

  function calc() {
    return lines.map((l) => ({ qtyMilli: toQtyMilli(l.qty) ?? 0, unitCents: toCents(l.unitPrice) ?? 0, excluded: allowOptional && Boolean(l.optional) }));
  }

  function totals() {
    const c = calc();
    const discountCents = toCents(discountInput.value || '0') ?? 0;
    const ded = deduction();
    const dedCents = ded ? ded.cents : 0;
    const t = computeTotals(c, discountCents + dedCents, taxesInput.checked);
    return { ...t, discountCents, deductionCents: dedCents, deductionLabel: ded ? ded.label : '', calc: c };
  }

  function renderMargin(t) {
    if (!marginEl) return;
    if (!allowCost || t.error) { marginEl.hidden = true; return; }
    const m = marginOf(lines.map((l, i) => ({ ...l, excluded: t.calc[i].excluded })), t.discountCents);
    if (!m) { marginEl.hidden = true; return; }
    const floor = marginFloor();
    const low = floor !== null && floor !== undefined && m.pct * 100 < floor;
    marginEl.hidden = false;
    marginEl.className = `margin-bar ${low ? 'is-low' : ''} ${m.profitCents < 0 ? 'is-loss' : ''}`;
    marginEl.replaceChildren(...[
      h('span', { class: 'margin-label' }, 'Marge (privé)'),
      h('strong', { class: 'num' }, `${pctFmt.format(m.pct)} · ${money2(m.profitCents / 100)}`),
      low ? h('span', { class: 'margin-note' }, `Sous ton plancher de ${floor} %`) : null,
      m.linesWithoutCost ? h('span', { class: 'margin-note' }, `${m.linesWithoutCost} ligne${m.linesWithoutCost > 1 ? 's' : ''} sans coût`) : null,
    ].filter(Boolean));
  }

  function update() {
    if (!active) return;
    const t = totals();
    t.calc.forEach((l, i) => {
      const el = document.getElementById(`${idPrefix}-total-${i}`);
      if (el) el.textContent = l.qtyMilli && l.unitCents ? money2(lineCents(l.qtyMilli, l.unitCents) / 100) : '—';
    });
    const row = (label, value, cls = '') => h('div', { class: `total-row ${cls}` }, h('dt', {}, label), h('dd', { class: 'num' }, value));
    const rows = [];
    if (t.error === 'discount') {
      rows.push(h('div', { class: 'field-error' }, t.deductionCents ? 'Le rabais et l’acompte dépassent le sous-total.' : 'Le rabais dépasse le sous-total.'));
    } else if (t.error) rows.push(h('div', { class: 'field-error' }, 'Total trop élevé.'));
    else {
      rows.push(row('Sous-total', money2(t.subtotalCents / 100)));
      if (t.discountCents) rows.push(row('Rabais', `− ${money2(t.discountCents / 100)}`));
      if (t.deductionCents) rows.push(row(t.deductionLabel || 'Acompte facturé', `− ${money2(t.deductionCents / 100)}`));
      if (taxesInput.checked) {
        rows.push(row('TPS (5 %)', money2(t.gstCents / 100)));
        rows.push(row('TVQ (9,975 %)', money2(t.qstCents / 100)));
      }
      rows.push(row(t.optionsCents ? 'Total de base' : (t.deductionCents ? 'Solde à payer' : 'Total'), money2(t.totalCents / 100), 'is-total'));
      if (t.optionsCents) rows.push(row('Options proposées, avant taxes', `+ ${money2(t.optionsCents / 100)}`, 'is-options'));
    }
    totalsEl.replaceChildren(...rows);
    renderMargin(t);
  }

  function render() {
    const writable = isWritable();
    const costs = allowCost && showCost();
    listEl.replaceChildren(...lines.map((line, i) => {
      const n = i + 1;
      const input = (key, attrs = {}) => {
        const el = h('input', { class: `input ${attrs.num ? 'num' : ''}`, id: `${idPrefix}-${key}-${i}`, autocomplete: 'off',
          inputmode: attrs.num ? 'decimal' : null, placeholder: attrs.placeholder || null, maxlength: attrs.max || null, disabled: !writable });
        el.value = line[key] ?? '';
        el.addEventListener('input', () => { line[key] = el.value; update(); });
        return el;
      };
      const step = (delta) => h('button', {
        class: 'qty-step', type: 'button', disabled: !writable, 'aria-label': `${delta > 0 ? 'Augmenter' : 'Diminuer'} la quantité de la ligne ${n}`,
        onClick: () => {
          const q = (toQtyMilli(line.qty) ?? 0) / 1000;
          const next = Math.round((q + delta) * 1000) / 1000;
          if (next <= 0) return;
          line.qty = decimalText(next);
          const el = document.getElementById(`${idPrefix}-qty-${i}`);
          if (el) el.value = line.qty;
          update();
        },
      }, delta > 0 ? '+' : '−');
      const showThisCost = allowCost && (costs || String(line.unitCost ?? '').trim() !== '');
      return h('div', { class: 'line' },
        h('div', { class: 'field line-desc' },
          h('label', { for: `${idPrefix}-description-${i}` }, `Ligne ${n}`, line.itemId ? h('span', { class: 'from-lib' }, ' · bibliothèque') : null),
          input('description', { placeholder: 'Description des travaux ou du matériel', max: '250' })),
        h('div', { class: `line-nums ${showThisCost ? 'has-cost' : ''}` },
          h('div', { class: 'field qty-field' }, h('label', { for: `${idPrefix}-qty-${i}` }, 'Qté'),
            h('div', { class: 'qty-wrap' }, step(-1), input('qty', { num: true }), step(1))),
          h('div', { class: 'field' }, h('label', { for: `${idPrefix}-unit-${i}` }, 'Unité'), input('unit', { placeholder: 'h, pi²', max: '12' })),
          h('div', { class: 'field' }, h('label', { for: `${idPrefix}-unitPrice-${i}` }, 'Prix unitaire'), input('unitPrice', { num: true, placeholder: '0,00' })),
          showThisCost
            ? h('div', { class: 'field cost-field' }, h('label', { for: `${idPrefix}-unitCost-${i}` }, 'Coût (privé)'), input('unitCost', { num: true, placeholder: '0,00' }))
            : null,
          h('div', { class: 'line-total' }, h('span', { class: 'label' }, 'Montant'), h('span', { class: 'num', id: `${idPrefix}-total-${i}` }, '—'))),
        allowOptional ? h('label', { class: 'check line-opt' },
          h('input', { type: 'checkbox', id: `${idPrefix}-optional-${i}`, checked: Boolean(line.optional), disabled: !writable,
            onChange: (ev) => { line.optional = ev.target.checked; update(); } }),
          h('span', {}, 'Option : ton client choisit de l’ajouter ou non')) : null,
        writable && lines.length > 1
          ? h('button', { class: 'btn btn-quiet btn-sm line-remove', type: 'button', onClick: () => { lines.splice(i, 1); render(); update(); } }, `Retirer la ligne ${n}`)
          : null);
    }));
  }

  discountInput.addEventListener('input', update);
  taxesInput.addEventListener('change', update);

  const out = (l) => {
    const line = { description: l.description, qty: l.qty, unit: l.unit, unitPrice: l.unitPrice, optional: allowOptional && Boolean(l.optional) };
    if (allowCost && String(l.unitCost ?? '').trim() !== '') line.unitCost = l.unitCost;
    if (allowCost && l.itemId) line.itemId = l.itemId;
    return line;
  };

  return {
    get lines() { return lines; },
    /** Remplace les lignes (copie) et redessine. */
    set(next) { lines = (next || []).map((l) => ({ ...l })); render(); update(); },
    /** Active ou désactive le calcul en direct (section repliée). */
    setActive(on) { active = on; if (on) update(); },
    ensureOne() { if (!lines.length) { lines = [emptyLine()]; render(); update(); } },
    add(preset = {}) {
      const last = lines[lines.length - 1];
      const line = { ...emptyLine(), ...preset };
      if (last && lineIsBlank(last)) lines[lines.length - 1] = line;
      else lines.push(line);
      render();
      update();
      const i = lines.length - 1;
      const focus = document.getElementById(preset.description ? `${idPrefix}-unitPrice-${i}` : `${idPrefix}-description-${i}`);
      if (focus && !preset.unitPrice) focus.focus();
    },
    /** Ajoute plusieurs lignes d'un coup (forfait de la bibliothèque) ; remplace une dernière ligne vide. */
    addMany(next) {
      if (!next || !next.length) return;
      const last = lines[lines.length - 1];
      if (last && lineIsBlank(last)) lines.pop();
      lines.push(...next.map((l) => ({ ...emptyLine(), ...l })));
      render();
      update();
    },
    /** Retire les lignes vides et renvoie les lignes à envoyer à l'API. */
    cleaned() {
      lines = lines.filter((l) => !lineIsBlank(l));
      render();
      update();
      return lines.map(out);
    },
    /** Lignes non vides, sans toucher à l'affichage (forfaits). */
    snapshot() { return lines.filter((l) => !lineIsBlank(l)).map(out); },
    totals,
    update,
    render,
  };
}
