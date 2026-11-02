// Hors ligne : l'app et tes dernières données restent disponibles sans réseau (service worker),
// et ce que tu fais sans réseau (nouvelle soumission, modification, signature sur place) attend dans une
// boîte d'envoi sur l'appareil, puis part tout seul au retour du réseau. Le numéro officiel est donné à l'envoi.
import { api } from './store.js';

const KEY = 'sp_outbox_v1';
export const API_CACHE = 'sp-api';
export const isTmpId = (id) => typeof id === 'string' && id.startsWith('tmp-');

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || (location.protocol !== 'https:' && location.hostname !== 'localhost')) return;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* navigateur sans service worker : l'app marche en ligne */ });
}

/** Déconnexion, suppression du compte, changement de compte : rien ne reste sur l'appareil. */
export async function clearOfflineData() {
  try { localStorage.removeItem(KEY); } catch { /* stockage indisponible */ }
  try { if ('caches' in window) await caches.delete(API_CACHE); } catch { /* rien en cache */ }
}

/**
 * @param {object} o
 * @param {string} o.userId     la boîte d'envoi appartient à un seul compte
 * @param {Function} o.onChange appelé quand la boîte d'envoi change
 */
export function createOutbox({ userId, onChange = () => {} }) {
  const read = () => {
    try {
      const d = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (d && d.userId === userId && Array.isArray(d.entries)) return d.entries;
    } catch { /* données illisibles : on repart */ }
    return [];
  };
  const write = (entries) => {
    try { localStorage.setItem(KEY, JSON.stringify({ userId, entries })); } catch { /* plein ou bloqué */ }
    onChange();
  };
  let flushing = false;

  return {
    entries: read,
    count: () => read().length,
    /** Nouvelle soumission sans réseau → brouillon local, id temporaire. */
    queueCreate(body) {
      const tmpId = `tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      write([...read(), { type: 'create', tmpId, body, at: Date.now() }]);
      return tmpId;
    },
    queueUpdate(id, body) {
      const entries = read();
      if (isTmpId(id)) {
        const c = entries.find((e) => e.type === 'create' && e.tmpId === id);
        if (c) { c.body = body; c.error = null; write(entries); return; }
      }
      write([...entries.filter((e) => !(e.type === 'update' && e.quoteId === id)), { type: 'update', quoteId: id, body, at: Date.now() }]);
    },
    queueSign(id, body) {
      write([...read(), { type: 'sign', quoteId: id, body, at: Date.now() }]);
      return true;
    },
    removeDraft(tmpId) {
      write(read().filter((e) => e.tmpId !== tmpId && e.quoteId !== tmpId));
    },
    drafts: () => read().filter((e) => e.type === 'create'),
    pendingUpdate: (id) => { const e = read().find((x) => x.type === 'update' && x.quoteId === id); return e ? e.body : null; },
    pendingSign: (id) => read().some((x) => x.type === 'sign' && x.quoteId === id),
    /** Envoie dans l'ordre. S'arrête au premier échec réseau ; une erreur de validation reste affichée sur le brouillon. */
    async flush() {
      if (flushing) return { sent: 0, failed: 0 };
      flushing = true;
      let sent = 0;
      let failed = 0;
      try {
        const entries = read();
        const map = {};
        const keep = [];
        let offline = false;
        for (const e of entries) {
          if (offline) { keep.push(e); continue; }
          const id = e.quoteId ? (map[e.quoteId] || e.quoteId) : null;
          if (id && isTmpId(id)) { keep.push(e); continue; } // son brouillon n'est pas encore parti
          try {
            if (e.type === 'create') {
              const r = await api('/api/quotes', { method: 'POST', body: e.body });
              map[e.tmpId] = r.quote.id;
            } else if (e.type === 'update') {
              await api(`/api/quotes/${id}`, { method: 'PUT', body: e.body });
            } else if (e.type === 'sign') {
              await api(`/api/quotes/${id}/sign`, { method: 'POST', body: e.body });
            }
            sent++;
          } catch (err) {
            if (err.status === 0) { offline = true; keep.push(e); continue; }
            failed++;
            keep.push({ ...e, error: err.message });
          }
        }
        // Les entrées gardées qui visaient un brouillon parti entre-temps prennent le vrai id.
        write(keep.map((e) => (e.quoteId && map[e.quoteId] ? { ...e, quoteId: map[e.quoteId] } : e)));
      } finally {
        flushing = false;
      }
      return { sent, failed };
    },
  };
}
