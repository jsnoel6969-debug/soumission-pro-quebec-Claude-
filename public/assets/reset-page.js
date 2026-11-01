import { api } from './store.js';

const form = document.getElementById('newPwForm');
const alertBox = form.querySelector('.alert-error');
const token = new URLSearchParams(location.search).get('token') || '';
// Retire le jeton de la barre d'adresse (historique, captures d'écran).
history.replaceState(null, '', '/reinitialiser');

function fail(message) {
  alertBox.textContent = message;
  alertBox.hidden = false;
}

if (!token) fail('Ce lien est incomplet. Demande un nouveau lien de réinitialisation.');

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  alertBox.hidden = true;
  const password = form.elements.password.value;
  if (!token) return fail('Ce lien est incomplet. Demande un nouveau lien de réinitialisation.');
  if (password.length < 8) return fail('Mot de passe : 8 caractères minimum.');
  if (password !== form.elements.confirm.value) return fail('Les deux mots de passe ne correspondent pas.');
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    await api('/api/auth/reset/confirm', { method: 'POST', body: { token, password } });
    location.replace('/app');
  } catch (err) {
    fail(err.message);
  } finally {
    btn.disabled = false;
  }
});
