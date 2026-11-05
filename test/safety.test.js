import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { setup, ADA, BAYO } from './helpers.js';
import { detectSecret, assertSafeOutbound } from '../src/guardrails.js';
import { verifySignature, parseWebhook, toApiPayload } from '../src/whatsapp.js';
import { steps } from '../src/engine.js';
import { runCampaign, assignGroup } from '../src/campaign.js';
import { mask } from '../src/log.js';

test('PINs, OTPs, card and ID numbers are blocked and never stored in full', async () => {
  const t = setup();
  await t.engine.startedByTemplate(ADA, await t.gw.findCustomer(ADA));
  for (const text of ['my pin is 4321', '482913', '5399 8312 4410 2231', 'my BVN 22233344455']) {
    await t.say(ADA, text);
    assert.match(t.last().text, /don’t send PINs, OTPs, card or ID numbers/);
  }
  const blocked = t.store.events((await t.gw.findCustomer(ADA)).ref).filter((e) => e.type === 'secret_blocked');
  assert.equal(blocked.length, 4);
  assert.ok(blocked.every((e) => !/\d/.test(e.detail.text)), 'stored text has no digits');
  assert.equal(t.store.getConversation(ADA).state, 'OPEN', 'conversation did not move on');
});

test('detectSecret leaves ordinary replies alone', () => {
  assert.equal(detectSecret('I moved to another bank'), null);
  assert.equal(detectSecret('keep 5000 for 30 days?'), null);
  assert.equal(detectSecret('my otp is 123456'), 'pin_or_otp');
});

test('outbound guard blocks requests for secrets or payments but allows warnings', () => {
  assert.throws(() => assertSafeOutbound({ type: 'text', text: 'Please send your PIN to continue.' }));
  assert.throws(() => assertSafeOutbound({ type: 'text', text: 'Kindly transfer ₦5,000 to this account now.' }));
  assert.doesNotThrow(() => assertSafeOutbound({ type: 'text', text: 'Olive MFB will never ask for your PIN. Never share your OTP with anyone.' }));
});

test('every step message passes the outbound guard and WhatsApp limits', async () => {
  const t = setup();
  const phones = ['+2348030000001', '+2348030000002', '+2348030000003', '+2348030000004'];
  const routes = [['see_reward', 'forgot_login', 'login_done', 'terms', 'fund', 'fund_other'], ['see_reward', 'restricted', 'kyc_submitted', 'fund'], ['see_reward', 'moved_bank', 'better_rewards', 'fund', 'funded'], ['see_reward', 'not_needed', 'fund', 'has_app_no']];
  for (let i = 0; i < phones.length; i++) {
    await t.engine.startedByTemplate(phones[i], await t.gw.findCustomer(phones[i]));
    for (const r of routes[i]) await t.tap(phones[i], r);
  }
  assert.ok(t.sent.length > 15);
  for (const m of t.sent) { assertSafeOutbound(m); toApiPayload(m.to, m); }
  assert.ok(Object.keys(steps).length >= 15);
});

test('STOP opts out at once and later messages get no reply; START opts back in', async () => {
  const t = setup();
  await t.engine.startedByTemplate(ADA, await t.gw.findCustomer(ADA));
  await t.say(ADA, 'STOP');
  assert.match(t.last().text, /won’t get more messages/);
  const count = t.sent.length;
  await t.say(ADA, 'hello?');
  assert.equal(t.sent.length, count, 'no message after opt-out');
  await t.say(ADA, 'START');
  assert.equal(t.store.getConversation(ADA).state, 'OPEN');
});

test('asking for a person hands off with a ticket, and the agent then stays quiet', async () => {
  const t = setup();
  await t.engine.startedByTemplate(ADA, await t.gw.findCustomer(ADA));
  await t.say(ADA, 'I want to talk to a person');
  assert.match(t.last().text, /reference T-/);
  const count = t.sent.length;
  await t.say(ADA, 'are you there');
  assert.equal(t.sent.length, count);
});

test('webhook signatures are checked with the app secret', () => {
  const body = Buffer.from('{"a":1}');
  const good = 'sha256=' + createHmac('sha256', 's3cret').update(body).digest('hex');
  assert.equal(verifySignature(body, good, 's3cret'), true);
  assert.equal(verifySignature(body, good, 'wrong'), false);
  assert.equal(verifySignature(body, undefined, 's3cret'), false);
});

test('webhook parsing handles text, buttons, lists and "not on WhatsApp" failures', () => {
  const p = { entry: [{ changes: [{ value: {
    messages: [
      { id: 'm1', from: '2348030000001', type: 'text', text: { body: 'hi' } },
      { id: 'm2', from: '2348030000001', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'moved_bank', title: 'I moved' } } },
      { id: 'm3', from: '2348030000001', type: 'button', button: { payload: 'see_reward', text: 'See my reward' } },
    ],
    statuses: [{ id: 'w1', recipient_id: '2348030000009', status: 'failed', errors: [{ code: 131026 }] }],
  } }] }] };
  const { messages, statuses } = parseWebhook(p);
  assert.deepEqual(messages.map((m) => [m.kind, m.replyId ?? m.text]), [['text', 'hi'], ['reply', 'moved_bank'], ['reply', 'see_reward']]);
  assert.equal(statuses[0].status, 'not_on_whatsapp');
});

test('campaign skips customers without consent and holds back a stable control group', async () => {
  const t = setup();
  const s = await runCampaign({ ...t, campaignId: 'test', controlShare: 0.3, pause: false });
  assert.equal(s.total, 9, 'Bayo has no consent and is excluded');
  assert.equal(s.outreach + s.control, 9);
  assert.equal(s.sent, s.outreach);
  assert.ok(!t.sent.some((m) => m.to === BAYO));
  const again = await runCampaign({ ...t, campaignId: 'test', controlShare: 0.3, pause: false });
  assert.equal(again.sent, 0, 'no one is messaged twice');
  assert.equal(assignGroup('C-1001', 'test', 0.3), assignGroup('C-1001', 'test', 0.3));
});

test('logs mask phone numbers and long digit strings', () => {
  assert.ok(!mask('+2348030000001 account 1100004821').includes('8030000001'));
  assert.ok(!mask('+2348030000001 account 1100004821').includes('110000482'));
});

test('webhook endpoint: verification handshake, signed message handled, bad signature rejected', async () => {
  const { createApp } = await import('../src/server.js');
  const t = setup();
  const app = createApp({ store: t.store, gw: t.gw, wa: t.wa, engine: t.engine, appSecret: 'sec', verifyToken: 'vt', requireSignature: true });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const hs = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42`);
    assert.equal(await hs.text(), '42');
    const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: 'wamid.1', from: '2348030000001', type: 'text', text: { body: 'Hello' } }] } }] }] });
    const sig = 'sha256=' + createHmac('sha256', 'sec').update(body).digest('hex');
    assert.equal((await fetch(`${base}/webhook`, { method: 'POST', body, headers: { 'x-hub-signature-256': sig } })).status, 200);
    assert.equal((await fetch(`${base}/webhook`, { method: 'POST', body, headers: { 'x-hub-signature-256': 'sha256=00' } })).status, 401);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t.store.getConversation('+2348030000001')?.state, 'OPEN');
    await fetch(`${base}/webhook`, { method: 'POST', body, headers: { 'x-hub-signature-256': sig } });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t.sent.filter((m) => m.to === '+2348030000001').length, 1, 'duplicate webhook delivery is ignored');
  } finally { app.server.close(); }
});
