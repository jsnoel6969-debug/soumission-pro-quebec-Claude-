import { api } from './store.js';
import { h } from './utils.js';

const $ = (id) => document.getElementById(id);
// Nouvelle session : les données hors ligne d'un autre compte ne doivent jamais s'afficher.
const clearOfflineCache = () => ('caches' in window ? caches.delete('sp-api').catch(() => false) : Promise.resolve(false));
const params = new URLSearchParams(location.search);
const next = (() => {
  const n = params.get('next') || '/app';
  return n.startsWith('/') && !n.startsWith('//') ? n : '/app'; // pas de redirection ouverte
})();

function setMode(mode) {
  const signup = mode !== 'connexion';
  $('tab-inscription').setAttribute('aria-selected', String(signup));
  $('tab-connexion').setAttribute('aria-selected', String(!signup));
  $('signupForm').hidden = !signup;
  $('loginForm').hidden = signup;
  $('authTitle').textContent = signup ? 'Crée ton compte' : 'Content de te revoir';
  $('authLede').hidden = !signup;
  document.title = `${signup ? 'Créer un compte' : 'Connexion'} | Soumission Pro`;
}

function showReset(show) {
  $('mainPanel').hidden = show;
  $('resetPanel').hidden = !show;
  if (show) {
    $('r-email').value = $('l-email').value;
    $('r-email').focus();
  }
}

function clearErrors(form) {
  form.querySelectorAll('.has-error').forEach((el) => el.classList.remove('has-error'));
  form.querySelectorAll('.field-error').forEach((el) => el.remove());
  const alert = form.querySelector('.alert-error');
  if (alert) alert.hidden = true;
}

function showError(form, err) {
  const wrap = err.field && err.code !== 'email_taken' && form.querySelector(`[data-field="${err.field}"]`);
  if (wrap) {
    wrap.classList.add('has-error');
    wrap.append(h('span', { class: 'field-error' }, err.message));
    const input = wrap.querySelector('input');
    if (input) input.focus();
    return;
  }
  const alert = form.querySelector('.alert-error');
  alert.replaceChildren(err.message);
  if (err.code === 'email_taken') {
    alert.append(' ', h('button', { type: 'button', class: 'btn-quiet', onClick: () => { setMode('connexion'); $('l-email').value = form.elements.email.value; $('l-password').focus(); } }, 'Se connecter'));
  }
  alert.hidden = false;
}

async function submit(form, path, body, onOk) {
  clearErrors(form);
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const data = await api(path, { method: 'POST', body });
    onOk(data);
  } catch (err) {
    showError(form, err);
  } finally {
    btn.disabled = false;
  }
}

$('signupForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const body = {
    displayName: f.elements.displayName.value,
    company: f.elements.company.value,
    email: f.elements.email.value,
    password: f.elements.password.value,
    acceptTerms: f.elements.acceptTerms.checked,
  };
  if (!body.displayName.trim()) return showError(f, { field: 'displayName', message: 'Ton prénom est requis.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.email.trim())) return showError(f, { field: 'email', message: 'Courriel invalide.' });
  if (body.password.length < 8) return showError(f, { field: 'password', message: 'Mot de passe : 8 caractères minimum.' });
  if (!body.acceptTerms) return showError(f, { field: 'acceptTerms', message: 'Accepte les conditions pour continuer.' });
  submit(f, '/api/auth/signup', body, () => clearOfflineCache().then(() => location.assign('/app?bienvenue=1')));
});

$('loginForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const f = ev.target;
  submit(f, '/api/auth/login', { email: f.elements.email.value, password: f.elements.password.value },
    () => clearOfflineCache().then(() => location.assign(next)));
});

$('resetForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const f = ev.target;
  submit(f, '/api/auth/reset/request', { email: f.elements.email.value }, (data) => {
    f.hidden = true;
    const done = $('resetDone');
    done.textContent = data.emailDelivery
      ? 'Si un compte existe avec ce courriel, un lien vient d’être envoyé. Vérifie aussi tes indésirables.'
      : `Demande reçue. Écris-nous${data.supportEmail ? ` à ${data.supportEmail}` : ''} depuis ce courriel : on t’envoie ton lien de réinitialisation rapidement.`;
    done.hidden = false;
  });
});

$('tab-inscription').addEventListener('click', () => setMode('inscription'));
$('tab-connexion').addEventListener('click', () => setMode('connexion'));
$('forgotLink').addEventListener('click', () => showReset(true));
$('backToLogin').addEventListener('click', () => { showReset(false); setMode('connexion'); });

document.querySelectorAll('[data-toggle-pw]').forEach((btn) => btn.addEventListener('click', () => {
  const input = $(btn.dataset.togglePw);
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? 'Masquer' : 'Afficher';
}));

// Déjà connecté? Directement à l'application.
api('/api/me').then(() => location.replace(next)).catch(() => {});

fetch('/api/public/config').then((r) => (r.ok ? r.json() : null)).then((cfg) => {
  if (cfg && cfg.trialDays) document.querySelectorAll('[data-cfg="trialDays"]').forEach((el) => { el.textContent = String(cfg.trialDays); });
}).catch(() => {});

setMode(params.get('mode') === 'connexion' ? 'connexion' : 'inscription');
if (params.get('mode') === 'oubli') showReset(true);
