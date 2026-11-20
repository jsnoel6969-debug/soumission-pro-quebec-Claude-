// Tests unitaires des fiches clients (sans base ni navigateur). Usage : node scripts/clients-test.mjs
import assert from 'node:assert/strict';
import { clientsOf } from '../public/assets/clients.js';

const quotes = [
  { client: 'Marc Tremblay', clientEmail: 'Marc@x.ca', clientPhone: '', status: 'accepted', amount: 4000, sentOn: '2026-10-01' },
  { client: 'M. Tremblay', clientEmail: 'marc@x.ca', clientPhone: '514-555-0101', status: 'pending', amount: 1500, sentOn: '2026-11-02' },
  { client: 'Sophie Roy', clientEmail: '', clientPhone: '', status: 'pending', amount: 900, sentOn: '2026-11-03' },
  { client: 'sophie  roy', clientEmail: '', clientPhone: '', status: 'refused', amount: 300, sentOn: '2026-10-20' },
  { client: '', clientEmail: '', status: 'pending', amount: 50, sentOn: '2026-11-04' },
];
const clients = clientsOf(quotes);
assert.equal(clients.length, 2, 'courriel identique (casse ignorée) fusionné ; nom sans accent/espaces fusionné');

const marc = clients.find((c) => c.email === 'marc@x.ca');
assert.equal(marc.count, 2);
assert.equal(marc.accepted, 4000);
assert.equal(marc.pending, 1);
assert.equal(marc.name, 'M. Tremblay', 'le nom le plus récent gagne');
assert.equal(marc.phone, '514-555-0101', 'téléphone repris d\'une soumission qui l\'a');

const sophie = clients.find((c) => c.key.startsWith('nom:'));
assert.equal(sophie.count, 2);
assert.equal(sophie.name, 'Sophie Roy');

assert.ok(!clients.some((c) => c.key === 'nom:'), 'soumission sans client ignorée');
console.log('clients-test : OK');
