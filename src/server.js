// Agent service: receives WhatsApp webhooks and runs the conversation engine.
import { createServer } from 'node:http';
import { config } from './config.js';
import { log } from './log.js';
import { createStore } from './store.js';
import { createGatewayClient } from './gateway.js';
import { createWhatsAppClient, verifySignature, parseWebhook } from './whatsapp.js';
import { createEngine } from './engine.js';

export function createApp({ store, gw, wa, engine, appSecret = config.wa.appSecret, verifyToken = config.wa.verifyToken, requireSignature = Boolean(config.wa.appSecret) || !config.dryRun } = {}) {
  store ??= createStore(config.dbPath);
  gw ??= createGatewayClient();
  wa ??= createWhatsAppClient({ store, onSend: (to, m) => log.info('dry-run send', { to, type: m.type, text: m.text }) });
  engine ??= createEngine({ store, gw, wa });

  async function processWebhook(payload) {
    const { messages, statuses } = parseWebhook(payload);
    for (const s of statuses) {
      const phone = store.setDelivery(s.waId, s.status);
      if (s.status === 'not_on_whatsapp' || s.status === 'failed') log.warn('delivery failed', { phone, status: s.status, codes: s.errors.map((e) => e.code) });
    }
    for (const m of messages) {
      if (!store.markProcessed(m.id)) continue; // duplicate delivery from WhatsApp
      if (m.kind === 'unsupported') {
        await wa.send(m.from, { type: 'text', text: 'Sorry, I can only read text and button replies here. Please don’t send photos of ID or cards in this chat.' });
        continue;
      }
      try { await engine.handleInbound(m); }
      catch (e) { log.error('engine error', { error: e.message, from: m.from }); }
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }

    if (url.pathname === '/webhook' && req.method === 'GET') {
      const ok = url.searchParams.get('hub.mode') === 'subscribe' && verifyToken && url.searchParams.get('hub.verify_token') === verifyToken;
      res.writeHead(ok ? 200 : 403); return res.end(ok ? url.searchParams.get('hub.challenge') : 'forbidden');
    }

    if (url.pathname === '/webhook' && req.method === 'POST') {
      const chunks = []; for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks);
      if (requireSignature && !verifySignature(raw, req.headers['x-hub-signature-256'], appSecret)) {
        log.warn('rejected webhook with bad signature'); res.writeHead(401); return res.end();
      }
      let payload;
      try { payload = JSON.parse(raw.toString('utf8')); } catch { res.writeHead(400); return res.end(); }
      res.writeHead(200); res.end(); // acknowledge fast; WhatsApp retries slow endpoints
      processWebhook(payload).catch((e) => log.error('webhook processing failed', { error: e.message }));
      return;
    }
    res.writeHead(404); res.end();
  });
  return { server, processWebhook, store, gw, wa, engine };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { server } = createApp();
  server.listen(config.port, () => log.info('agent service listening', { port: config.port, dryRun: config.dryRun, gateway: config.gateway.url }));
}
