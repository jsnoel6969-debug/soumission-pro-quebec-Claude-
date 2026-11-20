// Tests unitaires du courriel de relances (sans base ni réseau). Usage : node scripts/digest-test.mjs
import assert from 'node:assert/strict';
import { groupDueFollowUps, digestText } from '../src/lib/digest.js';

const rows = [
  { user_id: 'u1', email: 'a@x.ca', display_name: 'Marc', client: 'Tremblay', project: 'Toiture', follow_up_on: '2026-11-15' },
  { user_id: 'u1', email: 'a@x.ca', display_name: 'Marc', client: 'Gagnon', project: 'Salle de bain', follow_up_on: '2026-11-20' },
  { user_id: 'u2', email: 'b@x.ca', display_name: null, client: 'Roy', project: 'Galerie', follow_up_on: '2026-11-20' },
];
const groups = groupDueFollowUps(rows);
assert.equal(groups.length, 2, 'un groupe par entrepreneur');
assert.equal(groups[0].items.length, 2);
assert.equal(groups[1].items[0].client, 'Roy');

const text = digestText('Marc', groups[0].items, '2026-11-20');
assert.match(text, /2 relance\(s\)/);
assert.ok(text.indexOf('En retard') < text.indexOf("Aujourd'hui"), 'les retards passent en premier');
assert.match(text, /Tremblay/);
assert.doesNotMatch(text, /notes|coût|cost/i, 'aucune note privée ni coût');

console.log('digest-test : OK');
