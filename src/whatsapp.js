// WhatsApp Business Platform (Cloud API) client and webhook helpers.
// In DRY_RUN mode messages are printed and recorded, not sent.
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';

// Meta's limits for interactive messages.
const LIMITS = { body: 1024, button: 20, buttons: 3, rowTitle: 24, rows: 10, ctaText: 20 };

export function verifySignature(rawBody, header, appSecret = config.wa.appSecret) {
  if (!appSecret || !header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(header.slice(7), 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Turn a webhook payload into simple inbound messages and delivery statuses.
export function parseWebhook(payload) {
  const messages = [];
  const statuses = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      for (const m of v.messages ?? []) {
        const base = { id: m.id, from: '+' + String(m.from).replace(/^\+/, ''), timestamp: m.timestamp };
        if (m.type === 'text') messages.push({ ...base, kind: 'text', text: m.text?.body ?? '' });
        else if (m.type === 'interactive') {
          const r = m.interactive?.button_reply ?? m.interactive?.list_reply ?? {};
          messages.push({ ...base, kind: 'reply', replyId: r.id, text: r.title ?? '' });
        } else if (m.type === 'button') messages.push({ ...base, kind: 'reply', replyId: m.button?.payload, text: m.button?.text ?? '' });
        else messages.push({ ...base, kind: 'unsupported', type: m.type });
      }
      for (const s of v.statuses ?? []) {
        const notOnWhatsApp = (s.errors ?? []).some((e) => [131026, 131030].includes(e.code));
        statuses.push({ waId: s.id, to: '+' + String(s.recipient_id ?? '').replace(/^\+/, ''), status: notOnWhatsApp ? 'not_on_whatsapp' : s.status, errors: s.errors ?? [] });
      }
    }
  }
  return { messages, statuses };
}

function check(cond, msg) { if (!cond) throw new Error(`WhatsApp message invalid: ${msg}`); }

// Build Cloud API payloads from the engine's simple message objects.
export function toApiPayload(to, m) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/^\+/, '') };
  switch (m.type) {
    case 'text':
      check(m.text.length <= 4096, 'text too long');
      return { ...base, type: 'text', text: { body: m.text, preview_url: false } };
    case 'buttons':
      check(m.text.length <= LIMITS.body, 'body too long');
      check(m.buttons.length >= 1 && m.buttons.length <= LIMITS.buttons, 'max 3 buttons');
      m.buttons.forEach((b) => check(b.title.length <= LIMITS.button, `button title "${b.title}" over 20 characters`));
      return { ...base, type: 'interactive', interactive: { type: 'button', body: { text: m.text }, action: { buttons: m.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) } } };
    case 'list':
      check(m.text.length <= LIMITS.body, 'body too long');
      check(m.rows.length >= 1 && m.rows.length <= LIMITS.rows, 'max 10 rows');
      m.rows.forEach((r) => check(r.title.length <= LIMITS.rowTitle, `row title "${r.title}" over 24 characters`));
      return { ...base, type: 'interactive', interactive: { type: 'list', body: { text: m.text }, action: { button: m.button ?? 'Choose', sections: [{ title: 'Options', rows: m.rows.map((r) => ({ id: r.id, title: r.title, description: r.description })) }] } } };
    case 'cta':
      check(m.text.length <= LIMITS.body, 'body too long');
      check(m.label.length <= LIMITS.ctaText, 'button label over 20 characters');
      return { ...base, type: 'interactive', interactive: { type: 'cta_url', body: { text: m.text }, action: { name: 'cta_url', parameters: { display_text: m.label, url: m.url } } } };
    case 'template':
      return { ...base, type: 'template', template: { name: m.name, language: { code: m.lang ?? config.wa.templateLang }, components: m.params?.length ? [{ type: 'body', parameters: m.params.map((p) => ({ type: 'text', text: String(p) })) }] : [] } };
    default:
      throw new Error(`unknown message type ${m.type}`);
  }
}

export function createWhatsAppClient({ store, dryRun = config.dryRun, onSend } = {}) {
  return {
    async send(to, m) {
      const payload = toApiPayload(to, m); // validates limits even in dry run
      if (dryRun) {
        const id = 'dry.' + randomUUID();
        store?.outbound(to, m.type, m, id);
        onSend?.(to, m);
        return { id };
      }
      const url = `https://graph.facebook.com/${config.wa.apiVersion}/${config.wa.phoneNumberId}/messages`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.wa.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { log.error('whatsapp send failed', { status: res.status, error: data?.error?.message, to }); throw new Error(data?.error?.message || `WhatsApp ${res.status}`); }
      const id = data.messages?.[0]?.id ?? null;
      store?.outbound(to, m.type, m, id);
      return { id };
    },
  };
}
