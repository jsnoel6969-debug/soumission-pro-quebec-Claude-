// Bouclier Paiement : dossier imprimable d'une facture impayée, à remettre au notaire ou à l'avocat.
// Rassemble ce que l'entrepreneur a déjà dans l'app : créance, dates, soumission acceptée, signature, rappels.
import { api } from './store.js';
import { h, money2, dateLong, todayISO, daysBetween, shieldDates, PAYMENT_LABEL } from './utils.js';

const root = document.getElementById('root');
const id = new URLSearchParams(location.search).get('f') || '';
const fmtQty = new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 3 });
const stamp = (ms) => new Intl.DateTimeFormat('fr-CA', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(ms));
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

function rows(pairs) {
  return h('dl', { class: 'dossier-dl' }, pairs.filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))));
}

function section(title, ...children) {
  return h('section', { class: 'dossier-sec' }, h('h2', {}, title), children);
}

async function load() {
  let me;
  try {
    me = await api('/api/me');
  } catch (err) {
    if (err.status === 401) { location.replace(`/connexion?next=${encodeURIComponent(location.pathname + location.search)}`); return; }
    throw err;
  }
  const [{ invoices }, { quotes }] = await Promise.all([api('/api/invoices'), api('/api/quotes')]);
  const inv = invoices.find((x) => x.id === id);
  if (!inv) throw new Error('Facture introuvable dans ton compte.');
  const quote = inv.quoteId ? quotes.find((q) => q.id === inv.quoteId) : null;
  const deposit = quote ? invoices.find((x) => x.depositQuoteId === quote.id && x.status !== 'void') : null;
  let sig = null;
  if (quote && quote.hasSignature) {
    try { sig = await api(`/api/quotes/${quote.id}/signature`); } catch { sig = null; }
  }
  render(me.user, inv, quote, deposit, sig);
}

function render(u, inv, quote, deposit, sig) {
  const b = u.business || {};
  const today = todayISO();
  const late = inv.status === 'unpaid' && inv.dueOn < today ? daysBetween(inv.dueOn, today) : 0;
  const dates = inv.workEndOn ? shieldDates(inv.workEndOn) : null;
  document.title = `Dossier ${inv.number} | ${inv.client}`;

  root.replaceChildren(
    h('article', { class: 'slip doc dossier' },
      h('span', { class: 'slip-perf', 'aria-hidden': 'true' }),
      h('header', { class: 'doc-head' },
        h('div', { class: 'doc-from' },
          h('h1', {}, 'Dossier de protection du paiement'),
          h('p', {}, `Facture n° ${inv.number} · ${inv.client} · préparé le ${dateLong(today)}`))),
      h('p', { class: 'doc-state is-warn' },
        'Rappel de dates et d’informations tirées de Soumission Pro. Ce n’est pas un avis juridique : un avocat ou un notaire confirme les délais, prépare et inscrit l’avis d’hypothèque légale.'),

      section('Délais calculés depuis la fin des travaux', dates
        ? rows([
          ['Fin des travaux', dateLong(inv.workEndOn)],
          ['Inscription de l’hypothèque légale', `au plus tard le ${dateLong(dates.lienBy)} (${daysBetween(today, dates.lienBy) >= 0 ? plural(daysBetween(today, dates.lienBy), 'jour restant', 'jours restants') : 'délai passé'})`],
          ['Préavis d’exercice ou action', `au plus tard le ${dateLong(dates.preavisBy)}, sinon l’hypothèque s’éteint`],
        ])
        : h('p', {}, 'Date de fin des travaux absente : inscris-la dans la facture pour calculer les délais.')),

      section('Créance',
        rows([
          ['Facture', `n° ${inv.number} du ${dateLong(inv.issuedOn)}`],
          ['Montant', money2(inv.total)],
          ['Payable le', dateLong(inv.dueOn)],
          ['Statut', inv.status === 'paid' ? `Payée le ${dateLong(inv.paidOn)}${inv.paymentMethod ? ` (${PAYMENT_LABEL[inv.paymentMethod]})` : ''}` : (late ? `Impayée, en retard de ${plural(late, 'jour', 'jours')}` : 'Impayée')],
          ['Acompte', deposit ? `Facture d’acompte n° ${deposit.number} : ${money2(deposit.total)}, ${deposit.status === 'paid' ? `payée le ${dateLong(deposit.paidOn)}` : 'impayée'}` : null],
          ['Acompte déduit de la facture', inv.depositApplied ? `${money2(inv.depositApplied)} avant taxes` : null],
          ['Rappels de paiement', inv.reminderCount ? `${plural(inv.reminderCount, 'rappel', 'rappels')}, dernier le ${dateLong(inv.lastReminderOn)}` : 'Aucun noté dans l’app'],
          ['Consultations de la facture', inv.viewCount ? `${plural(inv.viewCount, 'ouverture', 'ouvertures')} par le client, la dernière le ${stamp(inv.lastViewedAt)}` : null],
        ])),

      section('Parties',
        rows([
          ['Entrepreneur', [u.company || u.displayName, b.businessAddress, b.businessPhone, b.businessEmail].filter(Boolean).join(' · ')],
          ['Licence RBQ', b.rbqNumber],
          ['TPS / TVQ', [b.gstNumber, b.qstNumber].filter(Boolean).join(' / ')],
          ['Client', inv.client],
          ['Adresse des travaux', inv.clientAddress || 'À compléter'],
          ['Courriel / téléphone du client', [inv.clientEmail, inv.clientPhone].filter(Boolean).join(' · ')],
        ])),

      quote ? section('Soumission acceptée',
        rows([
          ['Soumission', `${quote.number ? `n° ${quote.number}, ` : ''}« ${quote.project} »`],
          ['Montant accepté', money2(quote.amount)],
          ['Acceptée', quote.decidedOnlineAt ? `par ${quote.decidedByName} le ${stamp(quote.decidedOnlineAt)}, ${quote.signedInPerson ? 'signée en personne' : 'en ligne'}` : (quote.status === 'accepted' ? 'Marquée acceptée par l’entrepreneur' : null)],
          ['Signée au domicile du client', quote.signedAtHome ? 'Oui' : null],
          ['Sous-traitance', quote.subcontract ? (quote.denouncedOn ? `Contrat dénoncé au propriétaire le ${dateLong(quote.denouncedOn)}` : 'Oui, dénonciation non notée dans l’app') : null],
        ]),
        sig && sig.signature ? h('figure', { class: 'dossier-sig' }, h('img', { src: sig.signature, alt: `Signature de ${sig.signedBy}`, class: 'sig-image' }),
          h('figcaption', {}, `Signature de ${sig.signedBy}`)) : null) : null,

      section('Travaux facturés',
        h('div', { class: 'table-scroll' }, h('table', { class: 'doc-lines' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Description'), h('th', { class: 'r' }, 'Qté'), h('th', { class: 'r' }, 'Montant'))),
          h('tbody', {}, inv.items.map((it) => h('tr', {},
            h('td', { class: 'desc' }, it.description),
            h('td', { class: 'r qty' }, `${fmtQty.format(it.qty)}${it.unit ? ` ${it.unit}` : ''}`),
            h('td', { class: 'r line-amount' }, money2(it.total)))))))),

      section('À apporter au notaire ou à l’avocat',
        h('ul', { class: 'dossier-check' },
          ['Ce dossier imprimé', 'La soumission ou le contrat signé (copie du lien client)', 'Les factures et les preuves des paiements reçus',
            'Les preuves de la fin des travaux (photos datées, courriels, textos)', 'Le nom exact du propriétaire et l’adresse de l’immeuble',
            'Le numéro de lot de l’immeuble (registre foncier), si tu l’as', quote && quote.subcontract ? 'La preuve de la dénonciation de ton contrat au propriétaire' : null]
            .filter(Boolean).map((t) => h('li', {}, t))))),
    h('div', { class: 'doc-actions' },
      h('button', { class: 'btn btn-ink', type: 'button', onClick: () => window.print() }, 'Imprimer ou enregistrer en PDF'),
      h('a', { class: 'btn btn-ghost on-paper', href: '/app#factures' }, 'Retour à l’app')));
}

load().catch((err) => {
  root.replaceChildren(h('article', { class: 'slip doc' }, h('span', { class: 'slip-perf', 'aria-hidden': 'true' }),
    h('h1', {}, 'Dossier indisponible'), h('p', {}, err.message || 'Erreur inattendue.')));
});
