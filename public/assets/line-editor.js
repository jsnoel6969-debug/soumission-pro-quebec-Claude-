// Éditeur de lignes réutilisable (soumissions et factures) : quantités, unités, prix, rabais, TPS/TVQ en direct.
import { h, money2 } from './utils.js';
import { toCents, toQtyMilli, computeTotals, lineCents } from './money.js';

export const decimalText = (n) => (n === null || n === undefined || n === '' ? '' : String(n).replace('.', ','));
export const emptyLine = () => ({ description: '', qty: '1', unit: '', unitPrice: '' });
export const lineIsBlank = (l) => !String(l.description ?? '').trim() && !String(l.unitPrice ?? '').trim()
  && (!String(l.qty ?? '').trim() || String(l.qty).trim() === '1');

/** Lignes renvoyées par l'API (nombres) → lignes éditables (texte à la québécoise). */
export const toEditable = (items) => (items || []).map((it) => ({
  description: it.description, qty: decimalText(it.qty), unit: it.unit || '', unitPrice: decimalText(it.unitPrice),
  optional: Boolean(it.optional),
}));

/**
 * @param {object} o
 * @param {HTMLElement} o.listEl      conteneur des lignes
 * @param {HTMLElement} o.totalsEl    <dl> des totaux
 * @param {HTMLInputElement} o.discountInput
 * @param {HTMLInputElement} o.taxesInput  case à cocher TPS/TVQ
 * @param {string} o.idPrefix          préfixe des id (ex. « line » → line-qty-0)
 * @param {() => boolean} o.isWritable
 */
export function createLineEditor({ listEl, totalsEl, discountInput, taxesInput, idPrefix = 'line', isWritable = () => true, allowOptional = false }) {
  let lines = [];
  let active = true;

  function calc() {
    return lines.map((l) => ({ qtyMilli: toQtyMilli(l.qty) ?? 0, unitCents: toCents(l.unitPrice) ?? 0, excluded: allowOptional && Boolean(l.optional) }));
  }

  function totals() {
    const c = calc();
    const discountCents = toCents(discountInput.value || '0') ?? 0;
    return { ...computeTotals(c, discountCents, taxesInput.checked), calc: c };
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
    if (t.error === 'discount') rows.push(h('div', { class: 'field-error' }, 'Le rabais dépasse le sous-total.'));
    else if (t.error) rows.push(h('div', { class: 'field-error' }, 'Total trop élevé.'));
    else {
      rows.push(row('Sous-total', money2(t.subtotalCents / 100)));
      if (t.discountCents) rows.push(row('Rabais', `− ${money2(t.discountCents / 100)}`));
      if (taxesInput.checked) {
        rows.push(row('TPS (5 %)', money2(t.gstCents / 100)));
        rows.push(row('TVQ (9,975 %)', money2(t.qstCents / 100)));
      }
      rows.push(row(t.optionsCents ? 'Total de base' : 'Total', money2(t.totalCents / 100), 'is-total'));
      if (t.optionsCents) rows.push(row('Options proposées, avant taxes', `+ ${money2(t.optionsCents / 100)}`, 'is-options'));
    }
    totalsEl.replaceChildren(...rows);
  }

  function render() {
    const writable = isWritable();
    listEl.replaceChildren(...lines.map((line, i) => {
      const n = i + 1;
      const input = (key, attrs = {}) => {
        const el = h('input', { class: `input ${attrs.num ? 'num' : ''}`, id: `${idPrefix}-${key}-${i}`, autocomplete: 'off',
          inputmode: attrs.num ? 'decimal' : null, placeholder: attrs.placeholder || null, maxlength: attrs.max || null, disabled: !writable });
        el.value = line[key] ?? '';
        el.addEventListener('input', () => { line[key] = el.value; update(); });
        return el;
      };
      return h('div', { class: 'line' },
        h('div', { class: 'field line-desc' },
          h('label', { for: `${idPrefix}-description-${i}` }, `Ligne ${n}`),
          input('description', { placeholder: 'Description des travaux ou du matériel', max: '250' })),
        h('div', { class: 'line-nums' },
          h('div', { class: 'field' }, h('label', { for: `${idPrefix}-qty-${i}` }, 'Qté'), input('qty', { num: true })),
          h('div', { class: 'field' }, h('label', { for: `${idPrefix}-unit-${i}` }, 'Unité'), input('unit', { placeholder: 'h, pi²', max: '12' })),
          h('div', { class: 'field' }, h('label', { for: `${idPrefix}-unitPrice-${i}` }, 'Prix unitaire'), input('unitPrice', { num: true, placeholder: '0,00' })),
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
      if (focus) focus.focus();
    },
    /** Retire les lignes vides et renvoie les lignes à envoyer à l'API. */
    cleaned() {
      lines = lines.filter((l) => !lineIsBlank(l));
      render();
      update();
      return lines.map((l) => ({ description: l.description, qty: l.qty, unit: l.unit, unitPrice: l.unitPrice, optional: allowOptional && Boolean(l.optional) }));
    },
    totals,
    update,
    render,
  };
}
