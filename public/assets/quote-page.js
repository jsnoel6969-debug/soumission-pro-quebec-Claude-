// Page client : la soumission telle que le client la voit, avec acceptation ou refus en ligne.
import { api } from './store.js';
import { h, money2 } from './utils.js';

const root = document.getElementById('root');
const token = location.pathname.split('/').filter(Boolean).pop() || '';
// /s/… = soumission, /f/… = facture : même document, réponses différentes.
const KIND = location.pathname.startsWith('/f/') ? 'invoice' : 'quote';
const ENDPOINT = KIND === 'invoice' ? '/api/public/invoices/' : '/api/public/quotes/';
const fmtDate = new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'long', year: 'numeric' });
const fmtQty = new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 3 });
const dateText = (iso) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return fmtDate.format(new Date(y, m - 1, d));
};
const stampText = (ms) => new Intl.DateTimeFormat('fr-CA', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(ms));

function row(label, value, cls = '') {
  return h('div', { class: `total-row ${cls}` }, h('dt', {}, label), h('dd', { class: 'num' }, value));
}

function documentView(q, b, { label = 'Soumission', dates = [], totalLabel = null, partyLabel = 'Préparée pour' } = {}) {
  const contact = [b.contact, b.phone, b.email, b.address].filter(Boolean);
  const lines = q.detailed
    ? q.items.map((it) => h('tr', {},
      h('td', { class: 'desc' }, it.description),
      h('td', { class: 'r qty' }, `${fmtQty.format(it.qty)}${it.unit ? ` ${it.unit}` : ''}`),
      h('td', { class: 'r unit-price' }, money2(it.unitPrice)),
      h('td', { class: 'r line-amount' }, money2(it.total))))
    : [h('tr', {}, h('td', { class: 'desc' }, q.project), h('td', { class: 'r qty' }, '1'),
      h('td', { class: 'r unit-price' }, money2(q.total)), h('td', { class: 'r line-amount' }, money2(q.total)))];

  const totals = [];
  if (q.detailed) {
    totals.push(row('Sous-total', money2(q.subtotal)));
    if (q.discount) totals.push(row('Rabais', `− ${money2(q.discount)}`));
    if (q.taxes) {
      totals.push(row('TPS (5 %)', money2(q.gst)));
      totals.push(row('TVQ (9,975 %)', money2(q.qst)));
    }
  }
  totals.push(row(totalLabel || (q.detailed && q.taxes ? 'Total, taxes incluses' : 'Total'), money2(q.total), 'is-total'));

  const taxNums = [b.gstNumber && `N° de TPS : ${b.gstNumber}`, b.qstNumber && `N° de TVQ : ${b.qstNumber}`].filter(Boolean);

  return h('article', { class: 'slip doc', 'aria-labelledby': 'docTitle' },
    h('span', { class: 'slip-perf', 'aria-hidden': 'true' }),
    h('header', { class: 'doc-head' },
      h('div', { class: 'doc-from' },
        h('h1', { id: 'docTitle' }, b.name),
        contact.length ? h('div', { class: 'contact' }, contact.map((c) => h('p', {}, c))) : null,
        b.rbq ? h('p', { class: 'contact' }, `Licence RBQ : ${b.rbq}`) : null),
      h('div', { class: 'doc-meta' },
        h('p', { class: 'doc-kind' }, label),
        h('dl', {},
          q.number ? h('div', {}, h('dt', {}, 'N°'), h('dd', { class: 'num' }, q.number)) : null,
          dates.filter(([, iso]) => iso).map(([dt, iso]) => h('div', {}, h('dt', {}, dt), h('dd', {}, dateText(iso))))))),
    h('section', { class: 'doc-parties' },
      h('div', {}, h('h2', {}, partyLabel), h('p', {}, q.client), q.clientAddress ? h('p', {}, q.clientAddress) : null),
      h('div', {}, h('h2', {}, 'Projet'), h('p', {}, q.project))),
    h('div', { class: 'table-scroll' },
      h('table', { class: 'doc-lines' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Description'), h('th', { scope: 'col', class: 'r' }, 'Qté'),
          h('th', { scope: 'col', class: 'r' }, 'Prix unitaire'), h('th', { scope: 'col', class: 'r' }, 'Montant'))),
        h('tbody', {}, lines))),
    h('dl', { class: 'doc-totals' }, totals),
    q.terms ? h('section', { class: 'doc-terms' }, h('h2', {}, 'Conditions'), h('p', {}, q.terms)) : null,
    taxNums.length ? h('div', { class: 'doc-taxnums' }, taxNums.map((t) => h('p', {}, t))) : null);
}

function stateBanner(q, b, viewer) {
  if (viewer.isOwner) {
    return h('p', { class: 'doc-state is-owner' }, 'Aperçu : voici ce que ton client voit. Tes visites ne comptent pas comme des ouvertures.');
  }
  if (q.status === 'accepted') {
    return h('p', { class: 'doc-state is-go' }, q.decidedOnline
      ? `Soumission acceptée par ${q.decidedByName} le ${stampText(q.decidedAt)}. ${b.name} vous contactera pour planifier les travaux.`
      : `Cette soumission est acceptée. ${b.name} vous contactera pour la suite.`);
  }
  if (q.status === 'refused') {
    return h('p', { class: 'doc-state is-stop' }, q.decidedOnline
      ? `Vous avez refusé cette soumission le ${stampText(q.decidedAt)}. Merci d’avoir répondu.`
      : `Cette soumission n’est plus disponible. Communiquez avec ${b.name} pour une nouvelle soumission.`);
  }
  if (q.expired) {
    return h('p', { class: 'doc-state is-warn' }, `Cette soumission était valide jusqu’au ${dateText(q.validUntil)}. Communiquez avec ${b.name} pour une mise à jour.`);
  }
  return null;
}

function decisionView(data) {
  const { quote: q, business: b, viewer } = data;
  if (q.status !== 'pending' || q.expired) return null;

  const errorBox = h('div', { class: 'alert alert-error', role: 'alert', hidden: true });
  const nameInput = h('input', { class: 'input', id: 'd-name', autocomplete: 'name', maxlength: '120', required: true, disabled: viewer.isOwner });
  const confirmBox = h('input', { type: 'checkbox', id: 'd-confirm', disabled: viewer.isOwner });
  const acceptBtn = h('button', { class: 'btn btn-primary btn-block', type: 'submit', disabled: viewer.isOwner }, 'Accepter la soumission');
  const reason = h('textarea', { class: 'textarea', id: 'd-reason', maxlength: '1000', disabled: viewer.isOwner, placeholder: 'Ex. budget, échéancier, autre option retenue…' });
  const refuseBtn = h('button', { class: 'btn btn-ghost on-paper', type: 'submit', disabled: viewer.isOwner }, 'Confirmer le refus');

  async function decide(body, btn) {
    errorBox.hidden = true;
    btn.disabled = true;
    try {
      const fresh = await api(`${ENDPOINT}${encodeURIComponent(token)}/decision`, { method: 'POST', body });
      render(fresh);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      btn.disabled = false;
      if (err.code === 'already_decided' || err.code === 'expired') load();
    }
  }

  const acceptForm = h('form', {
    class: 'form-grid', novalidate: true,
    onSubmit: (ev) => {
      ev.preventDefault();
      if (nameInput.value.trim().length < 2) { errorBox.textContent = 'Inscrivez votre nom complet.'; errorBox.hidden = false; nameInput.focus(); return; }
      if (!confirmBox.checked) { errorBox.textContent = 'Cochez la case pour confirmer votre acceptation.'; errorBox.hidden = false; confirmBox.focus(); return; }
      decide({ decision: 'accept', name: nameInput.value, confirm: true }, acceptBtn);
    },
  },
  errorBox,
  h('div', { class: 'field' }, h('label', { for: 'd-name' }, 'Votre nom complet'), nameInput),
  h('label', { class: 'check' }, confirmBox,
    h('span', {}, `J’accepte cette soumission de ${b.name} au montant de ${money2(q.total)} et j’autorise l’entreprise à me contacter pour planifier les travaux.`)),
  acceptBtn);

  const refuseForm = h('form', {
    class: 'form-grid', novalidate: true,
    onSubmit: (ev) => { ev.preventDefault(); decide({ decision: 'refuse', name: nameInput.value, message: reason.value }, refuseBtn); },
  },
  h('div', { class: 'field' }, h('label', { for: 'd-reason' }, 'Raison (facultatif)'), reason),
  h('div', {}, refuseBtn));

  return h('section', { class: 'slip decision', 'aria-labelledby': 'decisionTitle' },
    h('span', { class: 'slip-perf', 'aria-hidden': 'true' }),
    h('h2', { id: 'decisionTitle' }, 'Votre réponse'),
    h('p', { class: 'lede' }, viewer.isOwner
      ? 'Ton client verra ici les boutons pour accepter ou refuser. Ils sont désactivés pour toi.'
      : `Répondez en ligne : ${b.name} verra votre réponse et communiquera avec vous.`),
    acceptForm,
    h('details', {}, h('summary', {}, 'Refuser la soumission'), refuseForm),
    h('p', { class: 'fine' }, 'Votre acceptation en ligne confirme votre accord avec cette soumission. Elle ne remplace pas un contrat écrit lorsque la loi en exige un.'));
}

function invoiceBanner(f, b, viewer) {
  if (viewer.isOwner) {
    return h('p', { class: 'doc-state is-owner' }, 'Aperçu : voici ce que ton client voit. Tes visites ne comptent pas comme des ouvertures.');
  }
  if (f.status === 'paid') return h('p', { class: 'doc-state is-go' }, `Facture payée le ${dateText(f.paidOn)}. Merci!`);
  if (f.status === 'void') return h('p', { class: 'doc-state is-stop' }, `Cette facture a été annulée. Communiquez avec ${b.name} pour toute question.`);
  if (f.overdue) return h('p', { class: 'doc-state is-warn' }, `Cette facture était payable le ${dateText(f.dueOn)}.`);
  return null;
}

function paymentView(f, b) {
  if (f.status !== 'unpaid') return null;
  return h('section', { class: 'slip decision', 'aria-labelledby': 'payTitle' },
    h('span', { class: 'slip-perf', 'aria-hidden': 'true' }),
    h('h2', { id: 'payTitle' }, 'Comment payer'),
    h('p', { class: 'lede' }, `${money2(f.total)} à payer d’ici le ${dateText(f.dueOn)}.`),
    b.paymentInstructions
      ? h('p', { class: 'pay-instructions' }, b.paymentInstructions)
      : h('p', {}, `Communiquez avec ${b.name}${b.phone ? ` au ${b.phone}` : ''} pour les modalités de paiement.`),
    h('p', { class: 'fine' }, `Indiquez le numéro de facture ${f.number} avec votre paiement.`));
}

function renderInvoice(data) {
  const { invoice: f, business: b, viewer } = data;
  document.title = `Facture ${f.number} | ${b.name}`;
  root.replaceChildren(...[
    invoiceBanner(f, b, viewer),
    documentView(f, b, {
      label: 'Facture',
      dates: [['Date', f.issuedOn], ['Payable d’ici le', f.status === 'unpaid' ? f.dueOn : null]],
      totalLabel: f.status === 'unpaid' ? 'Total à payer' : 'Total',
      partyLabel: 'Facturée à',
    }),
    paymentView(f, b),
    h('div', { class: 'doc-actions' },
      h('button', { class: 'btn btn-ink', type: 'button', onClick: () => window.print() }, 'Imprimer ou enregistrer en PDF'),
      h('p', { class: 'powered' }, 'Facture envoyée avec ', h('a', { href: '/?ref=lien-client' }, 'Soumission Pro'))),
  ].filter(Boolean));
}

function render(data) {
  if (KIND === 'invoice') { renderInvoice(data); return; }
  const { quote: q, business: b, viewer } = data;
  document.title = `Soumission${q.number ? ` ${q.number}` : ''} | ${b.name}`;
  root.replaceChildren(...[
    stateBanner(q, b, viewer),
    documentView(q, b, { dates: [['Date', q.sentOn], ['Valide jusqu’au', q.validUntil]] }),
    decisionView(data),
    h('div', { class: 'doc-actions' },
      h('button', { class: 'btn btn-ink', type: 'button', onClick: () => window.print() }, 'Imprimer ou enregistrer en PDF'),
      h('p', { class: 'powered' }, 'Soumission envoyée avec ', h('a', { href: '/?ref=lien-client' }, 'Soumission Pro'))),
  ].filter(Boolean));
}

async function load() {
  try {
    render(await api(`${ENDPOINT}${encodeURIComponent(token)}`));
  } catch (err) {
    const what = KIND === 'invoice' ? 'Facture introuvable' : 'Soumission introuvable';
    document.title = what;
    root.replaceChildren(h('article', { class: 'slip doc' },
      h('span', { class: 'slip-perf', 'aria-hidden': 'true' }),
      h('h1', {}, what),
      h('p', {}, err.message)));
  }
}

load();
