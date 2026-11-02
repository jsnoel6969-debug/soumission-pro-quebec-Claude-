// Onglet Factures : liste, encaissements, dialogue facture, paiements, lien client.
import {
  h, toast, todayISO, addDays, daysBetween, dateLong, relTime, money2, moneyRound, copyText, download,
  PAYMENT_LABEL, toInvoicesCsv, shieldDates,
} from './utils.js';
import { createLineEditor, toEditable } from './line-editor.js';

const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const FIELDS = ['client', 'project', 'discount', 'issuedOn', 'dueOn', 'workEndOn', 'clientEmail', 'clientPhone', 'clientAddress', 'terms', 'notes'];

/**
 * @param {object} ctx  dépendances fournies par app.js
 * @param {object} ctx.state         état partagé (store, me, quotes, invoices)
 * @param {Function} ctx.api         appel API JSON
 * @param {Function} ctx.$           document.getElementById
 * @param {Function} ctx.isDemo
 * @param {Function} ctx.canWrite
 * @param {Function} ctx.requireWrite
 * @param {Function} ctx.handleError
 * @param {Function} ctx.openMessage   ({ type: 'invoice', id, kind: 'send' | 'reminder' })
 * @param {Function} ctx.rerender      rafraîchit l'app (bannières, compteurs)
 */
export function createInvoicesUI(ctx) {
  const { state, api, $ } = ctx;
  let editingId = null;
  let editor = null;

  const find = (id) => (state.invoices || []).find((x) => x.id === id);
  const isOverdue = (inv, today = todayISO()) => inv.status === 'unpaid' && inv.dueOn < today;
  const linkUrl = (inv) => (inv && inv.shareToken ? `${location.origin}/f/${inv.shareToken}` : '');
  const invoiceFor = (quoteId) => (state.invoices || []).find((x) => x.quoteId === quoteId && x.status !== 'void')
    || (state.invoices || []).find((x) => x.quoteId === quoteId);
  const depositFor = (quoteId) => (state.invoices || []).find((x) => x.depositQuoteId === quoteId && x.status !== 'void');

  /**
   * Bouclier Paiement : pour une facture finale impayée avec une date de fin des travaux,
   * les délais de l'hypothèque légale (rappel de dates, pas un avis juridique).
   */
  function shield(inv, today = todayISO()) {
    if (!inv || inv.kind === 'deposit' || inv.status !== 'unpaid' || !inv.workEndOn) return null;
    const { lienBy, preavisBy } = shieldDates(inv.workEndOn);
    const daysToLien = daysBetween(today, lienBy);
    const daysToPreavis = daysBetween(today, preavisBy);
    const phase = daysToLien >= 0 ? 'lien' : (daysToPreavis >= 0 ? 'preavis' : 'past');
    return { lienBy, preavisBy, daysToLien, daysToPreavis, phase, urgent: phase === 'lien' && (daysToLien <= 10 || isOverdue(inv, today)) };
  }
  const dossierUrl = (inv) => `/dossier?f=${encodeURIComponent(inv.id)}`;

  async function load() {
    state.invoices = ctx.isDemo() ? [] : (await api('/api/invoices')).invoices;
  }

  async function refresh() {
    await load();
    ctx.rerender();
  }

  // ---------- Liste ----------
  function statusTag(inv, today) {
    if (inv.kind === 'deposit' && inv.status === 'unpaid') return h('span', { class: 'tag tag-due' }, 'Acompte à encaisser');
    if (inv.status === 'paid') return h('span', { class: 'tag tag-go' }, `Payée le ${dateLong(inv.paidOn)}`);
    if (inv.status === 'void') return h('span', { class: 'tag tag-stop' }, 'Annulée');
    const d = daysBetween(today, inv.dueOn);
    if (d < 0) return h('span', { class: 'tag tag-late' }, `En retard de ${plural(-d, 'jour', 'jours')}`);
    if (d === 0) return h('span', { class: 'tag tag-due' }, 'Payable aujourd’hui');
    return h('span', { class: 'tag' }, `Payable d’ici le ${dateLong(inv.dueOn)}`);
  }

  function viewTag(inv) {
    if (inv.status !== 'unpaid') return null;
    if (inv.viewCount > 0) return h('span', { class: 'tag' }, `Ouverte ${inv.viewCount} fois, ${relTime(inv.lastViewedAt)}`);
    return h('span', { class: 'tag' }, inv.shareToken ? 'Envoyée, pas encore ouverte' : 'Pas encore envoyée');
  }

  function slip(inv, today, { actions = false } = {}) {
    const overdue = isOverdue(inv, today);
    const classes = ['slip'];
    if (overdue) classes.push('is-due');
    if (inv.status === 'paid') classes.push('is-accepted');
    if (inv.status === 'void') classes.push('is-refused');
    const buttons = actions && inv.status === 'unpaid' ? h('div', { class: 'slip-actions' },
      overdue
        ? h('button', { class: 'btn btn-ink btn-sm', type: 'button', onClick: () => remind(inv.id) }, 'Rappeler le paiement')
        : h('button', { class: 'btn btn-ink btn-sm', type: 'button', onClick: () => shareAndSend(inv.id) }, inv.shareToken ? 'Renvoyer' : 'Envoyer'),
      h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onClick: () => open(inv.id, { focusPayment: true }) }, 'Marquer payée'),
    ) : null;
    return h('article', { class: classes.join(' ') },
      actions ? h('span', { class: 'slip-perf', 'aria-hidden': 'true' }) : null,
      h('div', { class: 'slip-head' },
        h('button', { class: 'slip-open', type: 'button', onClick: () => open(inv.id), 'aria-label': `Ouvrir la facture ${inv.number}, ${inv.client}` },
          h('span', { class: 'slip-client' }, inv.client)),
        h('span', { class: 'slip-amount' }, money2(inv.total))),
      h('p', { class: 'slip-project' }, inv.project),
      h('div', { class: 'slip-meta' },
        statusTag(inv, today), viewTag(inv),
        inv.kind === 'deposit' ? h('span', { class: 'tag' }, 'Acompte') : null,
        h('span', { class: 'num' }, `N° ${inv.number}`),
        inv.reminderCount ? h('span', {}, plural(inv.reminderCount, 'rappel envoyé', 'rappels envoyés')) : null),
      buttons);
  }

  function renderView() {
    const today = todayISO();
    const list = state.invoices || [];
    let dueSum = 0; let unpaidN = 0; let lateN = 0; let lateSum = 0; let paid30 = 0; let active = 0;
    const since = addDays(today, -30);
    for (const inv of list) {
      if (inv.status === 'void') continue;
      active++;
      if (inv.status === 'unpaid') {
        unpaidN++;
        dueSum += inv.total;
        if (isOverdue(inv, today)) { lateN++; lateSum += inv.total; }
      } else if (inv.paidOn && inv.paidOn >= since) paid30 += inv.total;
    }
    const stat = (label, value, sub, extra = '') => h('div', { class: `stat ${extra}` },
      h('dt', {}, label), h('dd', {}, value), h('span', { class: 'sub' }, sub));
    $('invStats').replaceChildren(
      stat('À encaisser', moneyRound(dueSum), plural(unpaidN, 'facture', 'factures')),
      stat('En retard', String(lateN), lateN ? moneyRound(lateSum) : 'Aucune', lateN ? 'is-due' : ''),
      stat('Encaissé, 30 jours', moneyRound(paid30), 'Paiements reçus'),
      stat('Factures', String(active), 'Hors annulées'),
    );
    $('invTabCount').textContent = unpaidN ? String(unpaidN) : '';

    const due = list.filter((inv) => inv.status === 'unpaid')
      .sort((a, b) => (Number(isOverdue(b, today)) - Number(isOverdue(a, today))) || (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0));
    $('invDueCount').textContent = due.length ? String(due.length) : '';
    let empty;
    if (ctx.isDemo()) {
      empty = h('div', { class: 'empty' },
        h('strong', {}, 'La facturation est incluse avec ton compte.'),
        'Une soumission acceptée devient une facture en un geste : TPS, TVQ, numéro, lien PDF pour ton client et suivi des paiements.',
        h('div', {}, h('a', { class: 'btn btn-primary', href: '/connexion?mode=inscription' }, 'Créer mon compte gratuit')));
    } else if (!list.length) {
      empty = h('div', { class: 'empty' },
        h('strong', {}, 'Aucune facture pour l’instant.'),
        'Ouvre une soumission acceptée et touche « Créer la facture ». Les lignes, les taxes et le client sont repris automatiquement.');
    } else {
      empty = h('div', { class: 'empty' }, h('strong', {}, 'Tout est encaissé.'), 'Aucune facture en attente de paiement.');
    }
    $('invDueList').replaceChildren(...(due.length ? due.map((inv) => slip(inv, today, { actions: true })) : [empty]));
    $('invAllCount').textContent = String(list.length);
    $('invList').replaceChildren(...(list.length
      ? list.map((inv) => slip(inv, today))
      : [h('div', { class: 'empty' }, 'Tes factures apparaîtront ici.')]));
  }

  // ---------- Dialogue ----------
  function clearErrors() {
    const form = $('invoiceForm');
    form.querySelectorAll('.has-error').forEach((el) => el.classList.remove('has-error'));
    form.querySelectorAll('.field-error').forEach((el) => el.remove());
    $('invoiceError').hidden = true;
  }

  function showError(field, message) {
    const form = $('invoiceForm');
    const line = field && field.match(/^items\.(\d+)\.(\w+)$/);
    let wrap = null;
    if (line) {
      const input = $(`inv-line-${line[2]}-${line[1]}`);
      wrap = input ? input.closest('.field') : null;
    } else if (field) wrap = form.querySelector(`[data-field="${field}"]`);
    if (!wrap) {
      $('invoiceError').textContent = message;
      $('invoiceError').hidden = false;
      $('invoiceError').scrollIntoView({ block: 'nearest' });
      return;
    }
    wrap.classList.add('has-error');
    wrap.append(h('span', { class: 'field-error' }, message));
    const input = wrap.querySelector('input, select, textarea');
    if (input) input.focus();
  }

  function renderPayBox(inv) {
    const box = $('payBox');
    const today = todayISO();
    if (inv.status === 'void') {
      box.className = 'pay-box is-void';
      box.replaceChildren(h('p', { class: 'pay-status' }, 'Facture annulée. Son numéro reste réservé pour ta comptabilité.'));
      return;
    }
    if (inv.status === 'paid') {
      box.className = 'pay-box is-paid';
      box.replaceChildren(
        h('p', { class: 'pay-status' }, `Payée le ${dateLong(inv.paidOn)}${inv.paymentMethod ? ` par ${PAYMENT_LABEL[inv.paymentMethod].toLowerCase()}` : ''}.`),
        ctx.canWrite() ? h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onClick: () => unmarkPaid(inv.id) }, 'Annuler le paiement')) : null);
      return;
    }
    const overdue = isOverdue(inv, today);
    const late = overdue ? -daysBetween(today, inv.dueOn) : 0;
    box.className = `pay-box ${overdue ? 'is-late' : ''}`;
    const dateInput = h('input', { class: 'input', type: 'date', id: 'i-paidOn', disabled: !ctx.canWrite() });
    dateInput.value = today;
    const method = h('select', { class: 'select', id: 'i-method', disabled: !ctx.canWrite() },
      ...Object.entries(PAYMENT_LABEL).map(([value, label]) => h('option', { value }, label)));
    box.replaceChildren(
      h('p', { class: 'pay-status' }, `À payer : ${money2(inv.total)} d’ici le ${dateLong(inv.dueOn)}.${overdue ? ` En retard de ${plural(late, 'jour', 'jours')}.` : ''}`),
      h('div', { class: 'form-row' },
        h('div', { class: 'field' }, h('label', { for: 'i-paidOn' }, 'Payée le'), dateInput),
        h('div', { class: 'field' }, h('label', { for: 'i-method' }, 'Mode de paiement'), method)),
      ctx.canWrite() ? h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-primary btn-sm', type: 'button', id: 'markPaid', onClick: () => markPaid(inv.id) }, 'Marquer payée')) : null);
  }

  function renderShieldBox(inv) {
    const box = $('shieldBox');
    const sh = shield(inv);
    if (!sh) {
      box.hidden = inv.kind === 'deposit' || inv.status !== 'unpaid';
      if (!box.hidden) {
        box.className = 'shield-box';
        box.replaceChildren(h('h3', {}, 'Bouclier Paiement'),
          h('p', {}, 'Inscris la date de fin des travaux plus bas : l’app calcule tes délais pour protéger ton paiement (hypothèque légale de la construction) et te les rappelle.'));
      }
      return;
    }
    box.hidden = false;
    box.className = `shield-box ${sh.urgent ? 'is-urgent' : ''}`;
    const lines = sh.phase === 'lien'
      ? [h('p', { class: 'shield-key' }, `Inscription de l’hypothèque légale : au plus tard le ${dateLong(sh.lienBy)} (${sh.daysToLien === 0 ? 'aujourd’hui' : `${sh.daysToLien} jours`}).`),
        h('p', {}, `Ensuite, préavis d’exercice ou action avant le ${dateLong(sh.preavisBy)}, sinon l’hypothèque s’éteint.`)]
      : sh.phase === 'preavis'
        ? [h('p', { class: 'shield-key' }, `Délai d’inscription passé le ${dateLong(sh.lienBy)}.`),
          h('p', {}, `Si l’hypothèque est inscrite : préavis d’exercice ou action avant le ${dateLong(sh.preavisBy)} (${sh.daysToPreavis} jours).`)]
        : [h('p', { class: 'shield-key' }, `Les délais de l’hypothèque légale sont passés (${dateLong(sh.preavisBy)}).`),
          h('p', {}, 'Il reste les recours ordinaires : parles-en à un avocat.')];
    box.replaceChildren(h('h3', {}, 'Bouclier Paiement'), ...lines,
      h('div', { class: 'btn-row' }, h('a', { class: 'btn btn-ink btn-sm', href: dossierUrl(inv), target: '_blank', rel: 'noopener' }, 'Préparer le dossier')),
      h('p', { class: 'hint' }, 'Rappel de dates calculées depuis la fin des travaux, pas un avis juridique. Un avocat ou un notaire confirme et fait l’inscription.'));
  }

  function renderLinkBox(inv) {
    const box = $('invLinkBox');
    box.hidden = false;
    const title = h('h3', { id: 'invLinkTitle' }, 'Lien client');
    if (!inv.shareToken) {
      box.replaceChildren(title,
        h('p', {}, 'Ton client consulte la facture, l’enregistre en PDF et voit tes modalités de paiement. Tu vois quand il l’ouvre.'),
        ctx.canWrite() && inv.status !== 'void'
          ? h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-ink btn-sm', type: 'button', onClick: () => shareAndSend(inv.id) }, 'Créer le lien et l’envoyer'))
          : null);
      return;
    }
    const url = linkUrl(inv);
    const field = h('input', { class: 'input', id: 'invLinkUrl', readonly: true, 'aria-label': 'Lien de la facture' });
    field.value = url;
    field.addEventListener('focus', () => field.select());
    box.replaceChildren(title,
      h('p', {}, inv.viewCount ? `Ouverte ${inv.viewCount} fois. Dernière ouverture ${relTime(inv.lastViewedAt)}.` : 'Pas encore ouverte par ton client.'),
      field,
      h('div', { class: 'btn-row' },
        inv.status === 'unpaid' ? h('button', { class: 'btn btn-ink btn-sm', type: 'button', onClick: () => { $('invoiceDialog').close(); ctx.openMessage({ type: 'invoice', id: inv.id, kind: isOverdue(inv) ? 'reminder' : 'send' }); } }, isOverdue(inv) ? 'Rappeler le paiement' : 'Envoyer au client') : null,
        h('button', { class: 'btn btn-ghost on-paper btn-sm', type: 'button', onClick: async () => {
          const ok = await copyText(url);
          toast(ok ? 'Lien copié.' : 'Copie impossible : sélectionne le lien et copie-le.', { error: !ok });
        } }, 'Copier le lien'),
        h('a', { class: 'btn btn-ghost on-paper btn-sm', href: url, target: '_blank', rel: 'noopener' }, 'Voir comme le client'),
        h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onClick: () => unshare(inv.id) }, 'Désactiver le lien')));
  }

  function open(id, { focusPayment = false } = {}) {
    const inv = find(id);
    if (!inv) return;
    editingId = id;
    clearErrors();
    const form = $('invoiceForm');
    $('invoiceTitle').textContent = `${inv.kind === 'deposit' ? 'Facture d’acompte' : 'Facture'} n° ${inv.number}`;
    for (const f of FIELDS) form.elements[f].value = f === 'discount' ? (inv.discount ? String(inv.discount).replace('.', ',') : '') : (inv[f] ?? '');
    form.querySelector('[data-field="workEndOn"]').hidden = inv.kind === 'deposit';
    form.elements.taxes.checked = inv.taxes;
    const editable = ctx.canWrite() && inv.status === 'unpaid';
    for (const f of FIELDS) form.elements[f].disabled = !editable;
    form.elements.taxes.disabled = !editable;
    $('invAddLine').disabled = !editable;
    editor.set(toEditable(inv.items));
    $('saveInvoice').hidden = !editable;
    $('saveSendInvoice').hidden = !editable;
    $('voidInvoice').hidden = !editable;
    if (!editable && inv.status === 'unpaid') {
      $('invoiceError').textContent = 'Lecture seule : active ton abonnement pour modifier tes factures.';
      $('invoiceError').hidden = false;
    }
    renderPayBox(inv);
    renderShieldBox(inv);
    renderLinkBox(inv);
    if (!$('invoiceDialog').open) $('invoiceDialog').showModal();
    if (focusPayment && $('markPaid')) $('payBox').scrollIntoView({ block: 'start' });
  }

  async function save(event) {
    event.preventDefault();
    if (!ctx.requireWrite()) return;
    clearErrors();
    const form = $('invoiceForm');
    const sendAfter = Boolean(event.submitter && event.submitter.dataset.send);
    const data = Object.fromEntries(FIELDS.map((f) => [f, form.elements[f].value]));
    data.taxes = form.elements.taxes.checked;
    data.workEndOn = data.workEndOn || null;
    data.items = editor.cleaned();
    if (!data.items.length) {
      editor.ensureOne();
      showError('items.0.description', 'Ajoute au moins une ligne à la facture.');
      return;
    }
    const buttons = [$('saveInvoice'), $('saveSendInvoice')];
    buttons.forEach((b) => { b.disabled = true; });
    try {
      await api(`/api/invoices/${editingId}`, { method: 'PUT', body: data });
      await refresh();
      if (sendAfter) await shareAndSend(editingId);
      else {
        $('invoiceDialog').close();
        toast('Facture enregistrée.');
      }
    } catch (e) {
      if (e.status === 400 && e.field) showError(e.field, e.message);
      else if (e.status === 401 || e.status === 402) { $('invoiceDialog').close(); ctx.handleError(e); }
      else showError(null, e.message);
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  }

  async function act(path, method, body, done) {
    if (!ctx.requireWrite()) return null;
    try {
      const r = await api(path, { method, body });
      await refresh();
      if (done) done(r.invoice);
      return r.invoice;
    } catch (e) {
      ctx.handleError(e);
      return null;
    }
  }

  const markPaid = (id) => act(`/api/invoices/${id}/payment`, 'POST', { paidOn: $('i-paidOn').value, method: $('i-method').value }, (inv) => {
    open(inv.id);
    toast(`Facture ${inv.number} marquée payée.`);
  });
  const unmarkPaid = (id) => act(`/api/invoices/${id}/payment`, 'DELETE', undefined, (inv) => { open(inv.id); toast('Paiement annulé.'); });

  async function voidIt() {
    const inv = find(editingId);
    if (!inv || !confirm(`Annuler la facture n° ${inv.number}? Elle restera dans ta liste, marquée annulée, et son numéro ne sera pas réutilisé.`)) return;
    await act(`/api/invoices/${inv.id}/void`, 'POST', {}, (fresh) => { open(fresh.id); toast('Facture annulée.'); });
  }

  async function shareAndSend(id) {
    const inv = await act(`/api/invoices/${id}/share`, 'POST', {});
    if (!inv) return;
    if ($('invoiceDialog').open) $('invoiceDialog').close();
    ctx.openMessage({ type: 'invoice', id: inv.id, kind: 'send' });
  }

  function remind(id) {
    const inv = find(id);
    if (!inv) return;
    if (!inv.shareToken) { shareAndSend(id); return; }
    ctx.openMessage({ type: 'invoice', id, kind: 'reminder' });
  }

  async function unshare(id) {
    if (!confirm('Désactiver ce lien? Ton client ne pourra plus ouvrir la facture avec l’ancien lien.')) return;
    await act(`/api/invoices/${id}/share`, 'DELETE', undefined, (inv) => { open(inv.id); toast('Lien désactivé.'); });
  }

  async function createFromQuote(quoteId) {
    if (ctx.isDemo()) {
      toast('Crée ton compte gratuit pour transformer tes soumissions en factures.');
      return;
    }
    if (!ctx.requireWrite()) return;
    try {
      const r = await api(`/api/quotes/${quoteId}/invoice`, { method: 'POST', body: {} });
      await refresh();
      toast(r.created ? `Facture n° ${r.invoice.number} créée. Vérifie-la, puis envoie-la.` : 'Cette soumission a déjà une facture.');
      open(r.invoice.id);
    } catch (e) { ctx.handleError(e); }
  }

  async function recordReminder(id) {
    await act(`/api/invoices/${id}/reminder`, 'POST', {}, () => toast('Rappel noté.'));
  }

  function exportCsv() {
    download(`factures-${todayISO()}.csv`, toInvoicesCsv(state.invoices || []), 'text/csv;charset=utf-8');
  }

  function wire() {
    const form = $('invoiceForm');
    editor = createLineEditor({
      listEl: $('invLines'), totalsEl: $('invTotals'), discountInput: form.elements.discount, taxesInput: form.elements.taxes,
      idPrefix: 'inv-line', isWritable: () => ctx.canWrite() && Boolean(find(editingId) && find(editingId).status === 'unpaid'),
      deduction: () => {
        const inv = find(editingId);
        return inv && inv.depositApplied ? { cents: Math.round(inv.depositApplied * 100), label: `Acompte facturé (${inv.depositRef || 'acompte'})` } : null;
      },
    });
    form.addEventListener('submit', save);
    $('invAddLine').addEventListener('click', () => editor.add());
    $('voidInvoice').addEventListener('click', voidIt);
  }

  async function createDeposit(quoteId, pct = null) {
    if (ctx.isDemo()) { toast('Crée ton compte gratuit pour facturer tes acomptes.'); return null; }
    if (!ctx.requireWrite()) return null;
    try {
      const r = await api(`/api/quotes/${quoteId}/deposit`, { method: 'POST', body: pct ? { pct } : {} });
      await refresh();
      toast(r.created ? `Facture d’acompte n° ${r.invoice.number} créée : ${money2(r.invoice.total)}.` : 'Cette soumission a déjà sa facture d’acompte.');
      open(r.invoice.id);
      return r.invoice;
    } catch (e) { ctx.handleError(e); return null; }
  }

  return {
    load, renderView, open, createFromQuote, createDeposit, invoiceFor, depositFor, find, linkUrl, recordReminder, exportCsv, wire,
    isOverdue, slip, shield, dossierUrl, remind,
  };
}
