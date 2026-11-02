// « Faire signer ici » : l'entrepreneur tend son téléphone, le client choisit ses options, signe au doigt et accepte.
// Écran client au vouvoiement. À la signature, le serveur crée la facture d'acompte (pourcentage du profil).
import { h, toast, money2, dateLong, todayISO, addDays } from './utils.js';
import { computeTotals } from './money.js';
import { createSignaturePad } from './signature-pad.js';

const fmtQty = new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 3 });

/**
 * @param {object} ctx
 * @param {object} ctx.state
 * @param {Function} ctx.api
 * @param {Function} ctx.$
 * @param {Function} ctx.requireWrite
 * @param {Function} ctx.handleError
 * @param {Function} ctx.afterSigned     (quote, deposit) → recharge l'app
 * @param {Function} ctx.openInvoice     (invoiceId)
 * @param {Function} ctx.sendCopy        (quoteId) → lien + message d'envoi
 * @param {Function} ctx.queueOffline    (quoteId, body) → true si gardé pour plus tard
 */
export function createSignUI(ctx) {
  const { state, $ } = ctx;
  let quote = null;
  let atHome = false;
  const chosen = new Set();

  const biz = () => {
    const u = state.me && state.me.user;
    return { name: (u && (u.company || u.displayName)) || 'Votre entrepreneur', business: (u && u.business) || {} };
  };

  function totalsFor(q) {
    const lines = q.items.map((it, i) => ({
      qtyMilli: Math.round(it.qty * 1000), unitCents: Math.round(it.unitPrice * 100), excluded: Boolean(it.optional) && !chosen.has(i),
    }));
    const t = computeTotals(lines, Math.round((q.discount || 0) * 100), q.taxes);
    if (t.error) return { subtotal: q.subtotal, discount: q.discount, gst: q.gst, qst: q.qst, total: q.amount };
    return { subtotal: t.subtotalCents / 100, discount: t.discountCents / 100, gst: t.gstCents / 100, qst: t.qstCents / 100, total: t.totalCents / 100 };
  }

  const body = () => $('signBody');
  const show = (...children) => { body().replaceChildren(...children); body().scrollTop = 0; };

  // ---------- 1. Entrepreneur : préparation ----------
  function prep() {
    const q = quote;
    const expired = q.validUntil && q.validUntil < todayISO();
    const home = h('input', { type: 'checkbox', id: 'sign-home', checked: atHome, onChange: (ev) => { atHome = ev.target.checked; } });
    $('signTitle').textContent = `Faire signer ${q.client}`;
    show(
      h('p', {}, `« ${q.project} », ${money2(q.amount)}${q.items.some((it) => it.optional) ? ' avant options' : ''}. Ton client choisit ses options, signe au doigt et accepte, directement sur ton téléphone.`),
      h('label', { class: 'check check-box' }, home, h('span', {}, 'Je fais signer au domicile du client')),
      h('p', { class: 'hint' }, 'Un contrat conclu chez le client peut lui donner 10 jours pour l’annuler (Loi sur la protection du consommateur). L’app note la date et te le rappelle. Valide tes obligations avec ton avocat.'),
      expired
        ? h('div', { class: 'alert alert-error' }, `Cette soumission était valide jusqu’au ${dateLong(q.validUntil)}. Change la date de validité avant de la faire signer.`)
        : null,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-primary btn-block', type: 'button', disabled: Boolean(expired), onClick: client }, 'Tendre le téléphone au client')));
  }

  // ---------- 2. Client : choix, signature, acceptation ----------
  function client() {
    const q = quote;
    const b = biz();
    $('signTitle').textContent = 'Votre soumission';
    const err = h('div', { class: 'alert alert-error', role: 'alert', hidden: true });
    const amount = h('span', { class: 'num' });
    const totalsEl = h('dl', { class: 'totals', 'aria-live': 'polite' });
    const nameInput = h('input', { class: 'input', id: 'sign-name', autocomplete: 'name', maxlength: '120' });
    nameInput.value = q.client;
    const confirmBox = h('input', { type: 'checkbox', id: 'sign-confirm' });
    const submit = h('button', { class: 'btn btn-primary btn-block btn-lg', type: 'submit' }, 'Signer et accepter');
    const pad = createSignaturePad({ id: 'sign-pad', label: 'Signez dans le cadre avec le doigt' });

    const row = (label, value, cls = '') => h('div', { class: `total-row ${cls}` }, h('dt', {}, label), h('dd', { class: 'num' }, value));
    function refresh() {
      const t = totalsFor(q);
      const rows = [row('Sous-total', money2(t.subtotal))];
      if (t.discount) rows.push(row('Rabais', `− ${money2(t.discount)}`));
      if (q.taxes) { rows.push(row('TPS (5 %)', money2(t.gst))); rows.push(row('TVQ (9,975 %)', money2(t.qst))); }
      rows.push(row(q.taxes ? 'Total, taxes incluses' : 'Total', money2(t.total), 'is-total'));
      totalsEl.replaceChildren(...(q.detailed ? rows : [row('Total', money2(q.amount), 'is-total')]));
      amount.textContent = money2(q.detailed ? t.total : q.amount);
    }

    const lines = q.detailed ? q.items.map((it, i) => h('li', { class: `sign-line ${it.optional && !chosen.has(i) ? 'is-off' : ''}`, id: `sign-line-${i}` },
      it.optional
        ? h('label', { class: 'opt-choice' },
          h('input', { type: 'checkbox', checked: chosen.has(i), onChange: (ev) => {
            if (ev.target.checked) chosen.add(i); else chosen.delete(i);
            $(`sign-line-${i}`).classList.toggle('is-off', !ev.target.checked);
            refresh();
          } }), 'Option, à ajouter si vous le souhaitez')
        : null,
      h('span', { class: 'sign-desc' }, it.description),
      h('span', { class: 'sign-qty' }, `${fmtQty.format(it.qty)}${it.unit ? ` ${it.unit}` : ''} × ${money2(it.unitPrice)}`),
      h('span', { class: 'sign-amt num' }, money2(it.total)))) : [];

    const form = h('form', {
      class: 'form-grid', novalidate: true,
      onSubmit: async (ev) => {
        ev.preventDefault();
        err.hidden = true;
        if (nameInput.value.trim().length < 2) { err.textContent = 'Inscrivez votre nom complet.'; err.hidden = false; nameInput.focus(); return; }
        if (pad.isEmpty()) { err.textContent = 'Signez dans le cadre avec le doigt.'; err.hidden = false; return; }
        if (!confirmBox.checked) { err.textContent = 'Cochez la case pour confirmer votre acceptation.'; err.hidden = false; confirmBox.focus(); return; }
        submit.disabled = true;
        const payload = { name: nameInput.value, confirm: true, options: [...chosen], signature: pad.dataUrl(), atHome };
        try {
          const r = await ctx.api(`/api/quotes/${q.id}/sign`, { method: 'POST', body: payload });
          done(r.quote, r.deposit);
          ctx.afterSigned(r.quote, r.deposit);
        } catch (e) {
          submit.disabled = false;
          if (e.status === 0 && ctx.queueOffline(q.id, payload)) { done({ ...q, decidedByName: payload.name, status: 'accepted' }, null, { offline: true }); return; }
          if (e.status === 401 || e.status === 402) { $('signDialog').close(); ctx.handleError(e); return; }
          err.textContent = e.message;
          err.hidden = false;
        }
      },
    },
    h('header', { class: 'sign-head' },
      h('p', { class: 'sign-biz' }, b.name),
      h('h3', {}, q.project),
      h('p', { class: 'hint' }, `Soumission${q.number ? ` n° ${q.number}` : ''} préparée pour ${q.client}${b.business.rbqNumber ? ` · Licence RBQ ${b.business.rbqNumber}` : ''}`)),
    q.detailed ? h('ul', { class: 'sign-lines' }, lines) : null,
    totalsEl,
    q.terms ? h('details', { class: 'sign-terms' }, h('summary', {}, 'Conditions'), h('p', {}, q.terms)) : null,
    err,
    h('div', { class: 'field' }, h('label', { for: 'sign-name' }, 'Votre nom complet'), nameInput),
    pad.el,
    h('label', { class: 'check' }, confirmBox,
      h('span', {}, `J’accepte cette soumission de ${b.name} au montant de `, amount,
        `${q.items.some((it) => it.optional) ? ', options choisies incluses,' : ''} et j’autorise l’entreprise à planifier les travaux.`)),
    submit,
    h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onClick: prep }, 'Retour à l’entrepreneur'));
    show(form);
    refresh();
    requestAnimationFrame(() => pad.resize());
  }

  // ---------- 3. Entrepreneur : signée, acompte ----------
  function done(q, deposit, { offline = false } = {}) {
    const b = biz();
    $('signTitle').textContent = 'Signée';
    const instructions = b.business.paymentInstructions;
    show(
      h('div', { class: 'sign-done' },
        h('p', { class: 'sign-check', 'aria-hidden': 'true' }, '✓'),
        h('h3', {}, `${q.decidedByName || q.client} a signé « ${q.project} »`),
        h('p', {}, offline
          ? 'Pas de réseau : la signature est gardée sur ce téléphone et partira toute seule au retour du réseau. La facture d’acompte sera créée à ce moment.'
          : `Total accepté : ${money2(q.amount)}.${atHome ? ` Signée à domicile : délai d’annulation possible jusqu’au ${dateLong(addDays(todayISO(), 10))}.` : ''}`)),
      deposit ? h('section', { class: 'pay-box' },
        h('p', { class: 'pay-status' }, `Facture d’acompte n° ${deposit.number} : ${money2(deposit.total)} à encaisser maintenant.`),
        instructions ? h('p', { class: 'pay-instructions' }, instructions) : h('p', { class: 'hint' }, 'Ajoute tes modalités de paiement (ex. virement Interac) dans ton profil pour les montrer ici.'),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn btn-ink btn-sm', type: 'button', onClick: () => { $('signDialog').close(); ctx.openInvoice(deposit.id); } }, 'Voir la facture d’acompte'))) : null,
      !offline ? h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-ink', type: 'button', onClick: () => { $('signDialog').close(); ctx.sendCopy(q.id); } }, 'Envoyer la copie signée au client'),
        h('button', { class: 'btn btn-ghost on-paper', type: 'button', onClick: () => $('signDialog').close() }, 'Terminer'))
        : h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-ink', type: 'button', onClick: () => $('signDialog').close() }, 'Terminer')));
    toast(offline ? 'Signature gardée hors ligne.' : 'Soumission signée et acceptée.');
  }

  function open(q) {
    if (!ctx.requireWrite()) return;
    if (!q || q.status !== 'pending') { toast('Seule une soumission en attente peut être signée.', { error: true }); return; }
    quote = q;
    atHome = false;
    chosen.clear();
    prep();
    if (!$('signDialog').open) $('signDialog').showModal();
  }

  return { open };
}
