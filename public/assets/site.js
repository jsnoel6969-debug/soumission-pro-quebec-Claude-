// Site public : configuration réelle (prix, essai, places), calculateur, liens de support.
const fmt = new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });
let config = { priceMonthly: 29, trialDays: 14, founderSeats: 10, founderSeatsLeft: null, supportEmail: '', legalName: '' };

function setAll(selector, text) {
  document.querySelectorAll(selector).forEach((el) => { el.textContent = text; });
}

function intFrom(input) {
  const n = Number.parseInt(String(input.value).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function updateCalc() {
  const value = document.getElementById('calcValue');
  const wins = document.getElementById('calcWins');
  if (!value || !wins) return;
  document.getElementById('calcGain').textContent = fmt.format(intFrom(value) * intFrom(wins));
  document.getElementById('calcCost').textContent = fmt.format(config.priceMonthly * 12);
}

function applyConfig() {
  const price = config.priceMonthly;
  const priceText = Number.isInteger(price) ? String(price) : price.toFixed(2).replace('.', ',');
  setAll('[data-cfg="price"]', priceText);
  setAll('[data-cfg="trialDays"]', String(config.trialDays));
  setAll('[data-cfg="supportEmail"]', config.supportEmail || 'à venir');
  setAll('[data-cfg="legalName"]', config.legalName || 'le fondateur de Soumission Pro');

  const roiAmount = 8450;
  if (price > 0) setAll('[data-roi-months]', String(Math.floor(roiAmount / price)));

  const seats = document.querySelector('[data-seats]');
  if (seats && config.founderSeatsLeft !== null && config.founderSeats > 0) {
    seats.hidden = false;
    seats.querySelector('[data-seats-text]').textContent = config.founderSeatsLeft > 0
      ? `${config.founderSeatsLeft} place${config.founderSeatsLeft > 1 ? 's' : ''} fondateur sur ${config.founderSeats} encore disponible${config.founderSeatsLeft > 1 ? 's' : ''}`
      : 'Places fondateur complètes';
  }

  document.querySelectorAll('[data-support]').forEach((a) => {
    if (!config.supportEmail) return;
    a.href = `mailto:${config.supportEmail}`;
    if (!a.textContent.trim()) a.textContent = config.supportEmail;
    a.hidden = false;
  });
  updateCalc();
}

async function loadConfig() {
  try {
    const res = await fetch('/api/public/config', { credentials: 'same-origin' });
    if (res.ok) config = { ...config, ...(await res.json()) };
  } catch { /* le site reste utilisable avec les valeurs par défaut */ }
  applyConfig();
}

for (const id of ['calcValue', 'calcWins']) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', updateCalc);
}

if (new URLSearchParams(location.search).get('compte') === 'supprime') {
  const note = document.createElement('div');
  note.className = 'banner';
  note.innerHTML = '<div class="wrap"><p>Ton compte et tes soumissions ont été supprimés.</p></div>';
  document.body.prepend(note);
}

loadConfig();
