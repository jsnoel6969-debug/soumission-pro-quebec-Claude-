// Signature au doigt (ou à la souris) sur un canevas. Exporte une image PNG compacte, fond blanc.
import { h } from './utils.js';

const OUT_W = 600; // largeur de l'image envoyée : lisible à l'impression, légère (quelques Ko)

/**
 * @param {object} o
 * @param {string} o.label        texte au-dessus du cadre
 * @param {string} o.id           id du canevas
 * @param {Function} [o.onChange] appelé quand la signature change (vide ou non)
 */
export function createSignaturePad({ label = 'Signez dans le cadre avec le doigt', id = 'sigPad', onChange = () => {} } = {}) {
  const canvas = h('canvas', { class: 'sig-canvas', id, role: 'img', 'aria-label': 'Zone de signature' });
  const clearBtn = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onClick: () => clear() }, 'Effacer');
  const el = h('div', { class: 'sig-wrap' },
    h('div', { class: 'sig-head' }, h('label', { for: id, class: 'sig-label' }, label), clearBtn),
    canvas,
    h('span', { class: 'sig-line', 'aria-hidden': 'true' }));
  const ctx = canvas.getContext('2d');
  let strokes = [];
  let current = null;
  let ratio = 1;

  function size() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    ratio = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    redraw();
  }

  function draw(stroke, c = ctx, scale = ratio) {
    if (!stroke.length) return;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = '#101b26';
    c.lineWidth = 2.4 * scale;
    c.beginPath();
    c.moveTo(stroke[0][0] * scale, stroke[0][1] * scale);
    if (stroke.length === 1) c.lineTo(stroke[0][0] * scale + 0.1, stroke[0][1] * scale + 0.1);
    for (let i = 1; i < stroke.length; i++) c.lineTo(stroke[i][0] * scale, stroke[i][1] * scale);
    c.stroke();
  }

  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of strokes) draw(s);
  }

  function point(ev) {
    const rect = canvas.getBoundingClientRect();
    return [ev.clientX - rect.left, ev.clientY - rect.top];
  }

  canvas.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    canvas.setPointerCapture(ev.pointerId);
    current = [point(ev)];
    strokes.push(current);
    redraw();
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!current) return;
    ev.preventDefault();
    current.push(point(ev));
    redraw();
  });
  const end = () => {
    if (!current) return;
    current = null;
    onChange(!isEmpty());
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', end);

  if ('ResizeObserver' in window) new ResizeObserver(size).observe(canvas);
  else window.addEventListener('resize', size);
  requestAnimationFrame(size);

  /** Assez de tracé pour être une signature (pas un simple toucher). */
  function isEmpty() {
    const points = strokes.reduce((n, s) => n + s.length, 0);
    return points < 8;
  }

  function clear() {
    strokes = [];
    redraw();
    onChange(false);
  }

  function dataUrl() {
    if (isEmpty()) return null;
    const rect = canvas.getBoundingClientRect();
    const scale = OUT_W / (rect.width || OUT_W);
    const out = document.createElement('canvas');
    out.width = OUT_W;
    out.height = Math.round((rect.height || 200) * scale);
    const c = out.getContext('2d');
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, out.width, out.height);
    for (const s of strokes) draw(s, c, scale);
    return out.toDataURL('image/png');
  }

  return { el, isEmpty, clear, dataUrl, resize: size };
}
