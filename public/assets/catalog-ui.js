// Bibliothèque : choisir un article ou un forfait en un toucher, gérer les prix, ajuster en masse (« Bois +8 % »).
import { h, toast, fold, money2, relTime } from './utils.js';
import { decimalText } from './line-editor.js';

const STALE_MS = 60 * 864e5; // prix vieux de 60 jours

/**
 * @param {object} ctx
 * @param {object} ctx.state          état partagé (catalog)
 * @param {Function} ctx.api
 * @param {Function} ctx.$
 * @param {Function} ctx.isDemo
 * @param {Function} ctx.canWrite
 * @param {Function} ctx.requireWrite
 * @param {Function} ctx.handleError
 * @param {Function} ctx.onPick       (lignes éditables) → ajout dans la soumission ouverte
 */
export function createCatalogUI(ctx) {
  const { state, api, $ } = ctx;
  let tab = 'pick';     // 'pick' | 'manage'
  let kind = 'package'; // filtre du choix : 'package' | 'item'
  let search = '';
  let editing = null;   // article en modification (gérer)

  const list = () => state.catalog || [];
  const byId = (id) => list().find((c) => c.id === id);
  const categories = () => [...new Set(list().map((c) => c.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));

  async function load() {
    if (ctx.isDemo()) { state.catalog = []; return; }
    state.catalog = (await api('/api/catalog')).catalog;
  }

  /** Ligne éditable à partir d'un article (prix et coût à jour). */
  function lineFromItem(item, qty = '1') {
    return {
      description: item.name, qty, unit: item.unit || '', unitPrice: decimalText(item.price),
      unitCost: item.cost === null || item.cost === undefined ? '' : decimalText(item.cost), itemId: item.id, optional: false,
    };
  }

  /** Lignes d'un forfait : une ligne liée à un article prend son prix et son coût actuels. */
  function linesFromPackage(pkg) {
    return pkg.lines.map((l) => {
      const item = l.itemId ? byId(l.itemId) : null;
      return {
        description: l.description, qty: decimalText(l.qty), unit: l.unit || (item ? item.unit : ''),
        unitPrice: decimalText(item ? item.price : l.unitPrice),
        unitCost: item ? (item.cost === null ? '' : decimalText(item.cost)) : (l.unitCost === undefined ? '' : decimalText(l.unitCost)),
        optional: Boolean(l.optional), ...(l.itemId && item ? { itemId: l.itemId } : {}),
      };
    });
  }

  function markUsed(id) {
    const c = byId(id);
    if (c) { c.useCount = (c.useCount || 0) + 1; c.lastUsedAt = Date.now(); }
    api(`/api/catalog/${id}/use`, { method: 'POST', body: {} }).catch(() => { /* compteur seulement */ });
  }

  function pick(c) {
    if (!ctx.canWrite()) { ctx.requireWrite(); return; }
    const lines = c.kind === 'package' ? linesFromPackage(c) : [lineFromItem(c)];
    ctx.onPick(lines);
    markUsed(c.id);
    $('catalogDialog').close();
    toast(c.kind === 'package' ? `Forfait « ${c.name} » ajouté : ${lines.length} lignes. Ajuste les quantités.` : `« ${c.name} » ajouté.`);
  }

  // ---------- Rendu ----------
  function stale(c) {
    return c.kind === 'item' && Date.now() - (c.priceUpdatedAt || 0) > STALE_MS;
  }

  function pickRow(c) {
    const meta = c.kind === 'package'
      ? `${c.lines.length} ligne${c.lines.length > 1 ? 's' : ''}${c.category ? ` · ${c.category}` : ''}`
      : `${money2(c.price)}${c.unit ? ` / ${c.unit}` : ''}${c.category ? ` · ${c.category}` : ''}`;
    return h('button', { class: 'cat-row', type: 'button', onClick: () => pick(c) },
      h('span', { class: 'cat-name' }, c.name),
      h('span', { class: 'cat-meta' }, meta, stale(c) ? h('span', { class: 'tag tag-due' }, 'Prix à vérifier') : null),
      h('span', { class: 'cat-add', 'aria-hidden': 'true' }, '+'));
  }

  function renderPick(body) {
    const input = h('input', { class: 'input', type: 'search', id: 'catSearch', placeholder: kind === 'package' ? 'Chercher un forfait' : 'Chercher un article', autocomplete: 'off' });
    input.value = search;
    input.addEventListener('input', () => { search = input.value; renderList(); });
    const listEl = h('div', { class: 'cat-list', id: 'catList' });
    function renderList() {
      const n = fold(search.trim());
      const rows = list().filter((c) => c.kind === kind && (!n || fold(`${c.name} ${c.category}`).includes(n)));
      listEl.replaceChildren(...(rows.length ? rows.map(pickRow) : [emptyPick()]));
    }
    function emptyPick() {
      if (!list().some((c) => c.kind === kind)) {
        return h('div', { class: 'empty' },
          h('strong', {}, kind === 'package' ? 'Aucun forfait pour l’instant.' : 'Aucun article pour l’instant.'),
          kind === 'package'
            ? 'Bâtis une soumission type (ex. « Salle de bain standard »), puis touche « Enregistrer comme forfait » sous les lignes. La prochaine fois : un toucher.'
            : 'Ajoute tes articles et taux horaires une fois (prix et coût), ils se placent ensuite en un toucher.',
          kind === 'item' ? h('div', {}, h('button', { class: 'btn btn-ink btn-sm', type: 'button', onClick: () => { tab = 'manage'; editing = { kind: 'item' }; render(); } }, 'Ajouter un article')) : null);
      }
      return h('div', { class: 'empty' }, 'Rien ne correspond à ta recherche.');
    }
    body.replaceChildren(
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'Type' },
        ...[['package', 'Forfaits'], ['item', 'Articles']].map(([k, label]) => h('button', {
          type: 'button', 'aria-pressed': String(kind === k), onClick: () => { kind = k; search = ''; render(); },
        }, label))),
      input, listEl);
    renderList();
  }

  function field(label, el, hint) {
    return h('div', { class: 'field' }, h('label', { for: el.id }, label), el, hint ? h('span', { class: 'hint' }, hint) : null);
  }

  function itemForm(item) {
    const err = h('div', { class: 'alert alert-error', role: 'alert', hidden: true });
    const inp = (id, value, attrs = {}) => {
      const el = h('input', { class: `input ${attrs.num ? 'num' : ''}`, id, autocomplete: 'off', inputmode: attrs.num ? 'decimal' : null,
        maxlength: attrs.max || null, placeholder: attrs.placeholder || null, list: attrs.list || null });
      el.value = value ?? '';
      return el;
    };
    const name = inp('cat-name', item.name, { max: '120', placeholder: 'Ex. Gypse 1/2 po, Main-d’œuvre' });
    const category = inp('cat-category', item.category, { max: '40', placeholder: 'Ex. Matériaux', list: 'catCategories' });
    const unit = inp('cat-unit', item.unit, { max: '12', placeholder: 'h, feuille, pi²' });
    const price = inp('cat-price', item.price === undefined ? '' : decimalText(item.price), { num: true, placeholder: '0,00' });
    const cost = inp('cat-cost', item.cost === undefined || item.cost === null ? '' : decimalText(item.cost), { num: true, placeholder: '0,00' });
    const isPkg = item.kind === 'package';
    return h('form', {
      class: 'form-grid cat-form', novalidate: true,
      onSubmit: async (ev) => {
        ev.preventDefault();
        if (!ctx.requireWrite()) return;
        err.hidden = true;
        const body = isPkg
          ? { kind: 'package', name: name.value, category: category.value, lines: item.lines }
          : { kind: 'item', name: name.value, category: category.value, unit: unit.value, price: price.value, cost: cost.value };
        try {
          if (item.id) await api(`/api/catalog/${item.id}`, { method: 'PUT', body });
          else await api('/api/catalog', { method: 'POST', body });
          await load();
          editing = null;
          render();
          toast(item.id ? 'Bibliothèque mise à jour.' : 'Ajouté à ta bibliothèque.');
        } catch (e) {
          if (e.status === 401 || e.status === 402) { ctx.handleError(e); return; }
          err.textContent = e.message;
          err.hidden = false;
        }
      },
    },
    h('h3', {}, item.id ? `Modifier ${isPkg ? 'le forfait' : 'l’article'}` : 'Nouvel article'),
    err,
    field('Nom', name),
    h('datalist', { id: 'catCategories' }, categories().map((c) => h('option', { value: c }))),
    isPkg ? field('Catégorie', category) : h('div', { class: 'form-row' }, field('Catégorie', category), field('Unité', unit)),
    isPkg ? h('p', { class: 'hint' }, `${item.lines.length} lignes. Pour changer les lignes : ajoute le forfait à une soumission, modifie, puis « Enregistrer comme forfait » avec le même nom.`) : null,
    isPkg ? null : h('div', { class: 'form-row' },
      field('Prix de vente', price, 'Ce que ton client paie.'),
      field('Coût (privé)', cost, 'Ce que ça te coûte. Jamais montré au client.')),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn btn-ink btn-sm', type: 'submit' }, item.id ? 'Enregistrer' : 'Ajouter'),
      h('button', { class: 'btn btn-ghost on-paper btn-sm', type: 'button', onClick: () => { editing = null; render(); } }, 'Annuler'),
      item.id ? h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onClick: () => remove(item) }, 'Supprimer') : null));
  }

  async function remove(item) {
    if (!confirm(`Supprimer « ${item.name} » de ta bibliothèque? Tes soumissions déjà faites ne changent pas.`)) return;
    try {
      await api(`/api/catalog/${item.id}`, { method: 'DELETE' });
      await load();
      editing = null;
      render();
      toast('Supprimé de ta bibliothèque.');
    } catch (e) { ctx.handleError(e); }
  }

  function adjustForm() {
    const cats = categories();
    const select = h('select', { class: 'select', id: 'adj-category' },
      h('option', { value: '' }, 'Tous les articles'), cats.map((c) => h('option', { value: c }, c)));
    const pct = h('input', { class: 'input num', id: 'adj-pct', inputmode: 'decimal', placeholder: 'Ex. 8 ou -5', autocomplete: 'off' });
    return h('form', {
      class: 'form-grid adjust-box', novalidate: true,
      onSubmit: async (ev) => {
        ev.preventDefault();
        if (!ctx.requireWrite()) return;
        const label = select.value || 'tous les articles';
        if (!confirm(`Ajuster ${label} de ${pct.value} %? Prix de vente et coûts bougent ensemble : ta marge en % reste la même.`)) return;
        try {
          const r = await api('/api/catalog/adjust', { method: 'POST', body: { category: select.value, percent: pct.value } });
          await load();
          render();
          toast(`${r.updated} article${r.updated > 1 ? 's' : ''} ajusté${r.updated > 1 ? 's' : ''}.`);
        } catch (e) { ctx.handleError(e); }
      },
    },
    h('h3', {}, 'Ajuster les prix d’un coup'),
    h('p', { class: 'hint' }, 'Le fournisseur augmente le bois de 8 %? Une seule opération. Les forfaits liés aux articles suivent.'),
    h('div', { class: 'form-row' }, field('Catégorie', select), field('Variation (%)', pct)),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-ink btn-sm', type: 'submit' }, 'Appliquer')));
  }

  function manageRow(c) {
    const meta = c.kind === 'package'
      ? `Forfait · ${c.lines.length} lignes`
      : `${money2(c.price)}${c.unit ? ` / ${c.unit}` : ''}${c.cost !== null ? ` · coût ${money2(c.cost)}` : ''}`;
    return h('button', { class: 'cat-row', type: 'button', onClick: () => { editing = c; render(); } },
      h('span', { class: 'cat-name' }, c.name),
      h('span', { class: 'cat-meta' }, meta, c.category ? ` · ${c.category}` : '',
        c.kind === 'item' ? ` · prix mis à jour ${relTime(c.priceUpdatedAt)}` : ''),
      h('span', { class: 'cat-add', 'aria-hidden': 'true' }, '›'));
  }

  function renderManage(body) {
    if (editing) { body.replaceChildren(itemForm(editing)); return; }
    const items = list();
    body.replaceChildren(
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-ink btn-sm', type: 'button', onClick: () => { editing = { kind: 'item' }; render(); } }, 'Nouvel article')),
      items.length ? h('div', { class: 'cat-list' }, items.map(manageRow)) : h('div', { class: 'empty' }, 'Ta bibliothèque est vide.'),
      items.some((c) => c.kind === 'item') ? adjustForm() : null);
  }

  function render() {
    const body = $('catalogBody');
    document.querySelectorAll('[data-cat-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.catTab === tab)));
    if (ctx.isDemo()) {
      body.replaceChildren(h('div', { class: 'empty' },
        h('strong', {}, 'La bibliothèque vient avec ton compte.'),
        'Tes articles, tes taux et tes forfaits, avec ton coût privé et ta marge, en un toucher dans chaque soumission.',
        h('div', {}, h('a', { class: 'btn btn-primary', href: '/connexion?mode=inscription' }, 'Créer mon compte gratuit'))));
      return;
    }
    if (tab === 'manage') renderManage(body);
    else renderPick(body);
  }

  async function open({ manage = false } = {}) {
    tab = manage ? 'manage' : 'pick';
    editing = null;
    search = '';
    if (!list().some((c) => c.kind === kind) && list().length) kind = list().some((c) => c.kind === 'package') ? 'package' : 'item';
    render();
    if (!$('catalogDialog').open) $('catalogDialog').showModal();
    try { await load(); render(); } catch { /* hors ligne : on garde la liste en mémoire */ }
  }

  /** Enregistre les lignes de la soumission comme forfait (remplace un forfait du même nom si confirmé). */
  async function saveAsPackage(lines) {
    if (ctx.isDemo()) { toast('Crée ton compte gratuit pour enregistrer tes forfaits.'); return; }
    if (!ctx.requireWrite()) return;
    if (!lines.length) { toast('Ajoute au moins une ligne avant d’en faire un forfait.', { error: true }); return; }
    const name = (prompt('Nom du forfait (ex. Salle de bain standard)') || '').trim();
    if (!name) return;
    const same = list().find((c) => c.kind === 'package' && fold(c.name) === fold(name));
    try {
      if (same) {
        if (!confirm(`Remplacer les lignes du forfait « ${same.name} »?`)) return;
        await api(`/api/catalog/${same.id}`, { method: 'PUT', body: { kind: 'package', name: same.name, category: same.category, lines } });
      } else {
        await api('/api/catalog', { method: 'POST', body: { kind: 'package', name, category: '', lines } });
      }
      await load();
      toast(same ? `Forfait « ${same.name} » mis à jour.` : `Forfait « ${name} » enregistré. Il est dans ta bibliothèque.`);
    } catch (e) { ctx.handleError(e); }
  }

  function wire() {
    document.querySelectorAll('[data-cat-tab]').forEach((b) => b.addEventListener('click', () => {
      tab = b.dataset.catTab;
      editing = null;
      render();
    }));
  }

  return { load, open, saveAsPackage, wire };
}
