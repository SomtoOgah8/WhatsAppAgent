// HTTP wrapper around the mock gateway, so the agent can be tested over the
// network exactly as it will talk to Olive's real gateway.
// Auth: Bearer token. Every write accepts an Idempotency-Key header.
import { createServer } from 'node:http';
import { config } from '../src/config.js';
import { createMockGateway } from './logic.js';

export function createGatewayServer(gw = createMockGateway({ rewardDailyCap: config.mock.rewardDailyCap }), token = config.mock.token) {
  const routes = {
    'POST /v1/customers/find': (b) => gw.findCustomer(b.phone) ?? { error: 'not_found' },
    'GET /v1/customers/inactive': () => gw.listInactive({ consentOnly: true }),
    'GET /v1/customers/:ref/status': (_, p) => gw.getAccountStatus(p.ref),
    'POST /v1/customers/:ref/kyc-link': (_, p) => gw.startKycUpdate(p.ref),
    'GET /v1/customers/:ref/app-links': (_, p) => gw.getAppLinks(p.ref),
    'GET /v1/customers/:ref/deposit-details': (_, p) => gw.getDepositDetails(p.ref),
    'POST /v1/customers/:ref/reward': (b, p) => gw.enrolReward(p.ref, b.offer_id),
    'GET /v1/customers/:ref/reward': (_, p) => gw.checkReward(p.ref),
    'POST /v1/customers/:ref/reward/pay': (_, p, h) => gw.payReward(p.ref, h['idempotency-key']),
    'POST /v1/customers/:ref/opt-out': (b, p) => gw.setOptOut(p.ref, b.opted_out),
    'POST /v1/customers/:ref/feedback': (b, p) => gw.recordFeedback(p.ref, b.feedback),
    'POST /v1/customers/:ref/handoff': (b, p) => gw.handoff(p.ref, b.summary),
    // sandbox only
    'POST /sim/:ref/deposit': (b, p) => gw.sim.deposit(p.ref, b.amount),
    'POST /sim/:ref/withdraw': (b, p) => gw.sim.withdraw(p.ref, b.amount),
    'POST /sim/advance-days': (b) => gw.sim.advanceDays(b.days),
  };
  const compiled = Object.entries(routes).map(([k, fn]) => {
    const [method, path] = k.split(' ');
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, n) => { keys.push(n); return '([^/]+)'; }) + '$');
    return { method, re, keys, fn };
  });

  return createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorised' });
    const url = new URL(req.url, 'http://x');
    const route = compiled.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!route) return send(404, { error: 'no such route' });
    const m = url.pathname.match(route.re);
    const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    let body = {};
    if (req.method === 'POST') {
      const chunks = []; for await (const c of req) chunks.push(c);
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { return send(400, { error: 'invalid json' }); }
    }
    try { send(200, await route.fn(body, params, req.headers)); }
    catch (e) { send(e.status || 500, { error: e.message }); }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createGatewayServer().listen(config.mock.port, () => console.log(`Mock Olive gateway on http://localhost:${config.mock.port}`));
}
