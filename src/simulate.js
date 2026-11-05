// Chat with the agent in your terminal. Uses the mock gateway and prints the
// WhatsApp messages instead of sending them. Type a number to tap an option.
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomUUID } from 'node:crypto';
import { createStore } from './store.js';
import { createGatewayClient } from './gateway.js';
import { createWhatsAppClient } from './whatsapp.js';
import { createEngine } from './engine.js';
import { runRewardJob } from './rewards.js';

const C = { dim: '\x1b[2m', green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m', reset: '\x1b[0m', bold: '\x1b[1m' };
let choices = [];

function show(to, m) {
  const head = `${C.green}${C.bold}Olive MFB${C.reset}${C.dim} → ${to}${C.reset}`;
  if (m.type === 'template') { console.log(`${head}\n  ${C.yellow}[template: ${m.name}]${C.reset} ${C.dim}${(m.params ?? []).join(' · ')}${C.reset}\n`); if (m.name.includes('opening')) setChoices([{ id: 'see_reward', title: 'See my reward' }, { id: 'stop', title: 'Stop messages' }]); return; }
  console.log(`${head}\n  ${m.text.replace(/\n/g, '\n  ')}`);
  if (m.type === 'cta') console.log(`  ${C.cyan}[ ${m.label} ] → ${m.url}${C.reset}`);
  if (m.type === 'buttons') setChoices(m.buttons);
  if (m.type === 'list') setChoices(m.rows);
  console.log();
}
function setChoices(list) {
  choices = list;
  list.forEach((o, i) => console.log(`  ${C.cyan}${i + 1}) ${o.title}${C.reset}`));
}

const store = createStore(':memory:');
const gw = createGatewayClient({ url: 'inprocess' });
const wa = createWhatsAppClient({ store, dryRun: true, onSend: show });
const engine = createEngine({ store, gw, wa });

const people = gw.mock.listInactive({ consentOnly: true });
console.log(`${C.bold}Olive reactivation agent — local simulator${C.reset}
Sample customers (synthetic): ${people.map((p) => `${p.first_name} ${p.phone}`).join(', ')}
Commands: number = tap option · any text = type a reply · /deposit 10000 · /withdraw 8000 · /days 15 · /rewards · /log · /quit
`);

const rl = readline.createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
const lines = rl[Symbol.asyncIterator]();
const ask = async (prompt) => { stdout.write(prompt); const r = await lines.next(); if (r.done) process.exit(0); if (!stdin.isTTY) stdout.write(r.value + '\n'); return r.value; };

const phone = (await ask('Phone to play (Enter for Ada +2348030000001): ')).trim() || '+2348030000001';
const me = gw.mock.findCustomer(phone);
if (!me) { console.log('No synthetic customer with that number.'); process.exit(1); }
if (!me.consent_whatsapp) { console.log(`${me.first_name} has not agreed to WhatsApp contact, so the campaign would skip them.`); process.exit(0); }

// Send the approved opening template to this one customer, as the campaign would.
await wa.send(phone, { type: 'template', name: 'olive_reactivation_opening', params: [me.first_name] });
await engine.startedByTemplate(phone, me);

for (;;) {
  const line = (await ask(`${C.bold}${me.first_name}>${C.reset} `)).trim();
  if (!line) continue;
  if (line === '/quit') break;
  if (line.startsWith('/deposit')) { console.log(gw.mock.sim.deposit(me.ref, Number(line.split(' ')[1] || 10000))); continue; }
  if (line.startsWith('/withdraw')) { console.log(gw.mock.sim.withdraw(me.ref, Number(line.split(' ')[1] || 1000))); continue; }
  if (line.startsWith('/days')) { console.log(gw.mock.sim.advanceDays(Number(line.split(' ')[1] || 1))); continue; }
  if (line === '/rewards') { console.log(await runRewardJob({ store, gw, wa, now: new Date(gw.mock.sim.now()) })); continue; }
  if (line === '/log') { console.table(store.events(me.ref).map((e) => ({ at: e.at.slice(11, 19), type: e.type, detail: JSON.stringify(e.detail) }))); continue; }
  const n = Number(line);
  const msg = Number.isInteger(n) && choices[n - 1]
    ? { id: randomUUID(), from: phone, kind: 'reply', replyId: choices[n - 1].id, text: choices[n - 1].title }
    : { id: randomUUID(), from: phone, kind: 'text', text: line };
  choices = [];
  console.log();
  await engine.handleInbound(msg);
}
rl.close();
