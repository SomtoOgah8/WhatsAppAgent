import { randomUUID } from 'node:crypto';
import { createStore } from '../src/store.js';
import { createGatewayClient } from '../src/gateway.js';
import { createWhatsAppClient } from '../src/whatsapp.js';
import { createEngine } from '../src/engine.js';
import { createMockGateway } from '../mock-gateway/logic.js';

// A fresh agent with an in-memory store, the mock gateway and a recording WhatsApp client.
export function setup() {
  const sent = [];
  const store = createStore(':memory:');
  const gw = createGatewayClient({ url: 'inprocess', mock: createMockGateway() });
  const wa = createWhatsAppClient({ store, dryRun: true, onSend: (to, m) => sent.push({ to, ...m }) });
  const engine = createEngine({ store, gw, wa });
  const say = (from, text) => engine.handleInbound({ id: randomUUID(), from, kind: 'text', text });
  const tap = (from, replyId) => engine.handleInbound({ id: randomUUID(), from, kind: 'reply', replyId, text: replyId });
  const last = () => sent[sent.length - 1];
  const textsTo = (phone) => sent.filter((m) => m.to === phone).map((m) => m.text ?? `[template ${m.name}]`);
  return { sent, store, gw, wa, engine, say, tap, last, textsTo };
}

export const ADA = '+2348030000001';   // has app, not restricted
export const MUSA = '+2348030000002';  // has app, KYC required
export const CHIKA = '+2348030000003'; // no app
export const TOLU = '+2348030000004';  // app status unknown
export const BAYO = '+2348030000005';  // no WhatsApp consent
