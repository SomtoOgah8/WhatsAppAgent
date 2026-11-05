import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, ADA, MUSA, CHIKA, TOLU } from './helpers.js';

async function opened(t, phone) {
  const me = await t.gw.findCustomer(phone);
  await t.engine.startedByTemplate(phone, me);
  return me;
}

test('forgot login, with the app: reset link, then the offer', async () => {
  const t = setup();
  await opened(t, ADA);
  await t.tap(ADA, 'see_reward');
  assert.equal(t.last().type, 'list');
  await t.tap(ADA, 'forgot_login');
  const cta = t.sent.find((m) => m.type === 'cta');
  assert.match(cta.url, /reset-login/);
  await t.tap(ADA, 'login_done');
  assert.match(t.last().text, /₦500 cashback/);
  assert.equal(t.store.getConversation(ADA).state, 'OFFER');
});

test('restricted account gets a secure KYC form, never asks for ID in chat', async () => {
  const t = setup();
  await opened(t, MUSA);
  await t.tap(MUSA, 'see_reward');
  await t.tap(MUSA, 'restricted');
  const cta = t.sent.find((m) => m.type === 'cta');
  assert.match(cta.url, /secure\.olivemfb\.example\/kyc\//);
  assert.match(cta.text, /don’t send ID/);
  await t.tap(MUSA, 'kyc_submitted');
  assert.equal(t.store.getConversation(MUSA).state, 'OFFER');
});

test('customer without the app gets bank transfer, USSD and agent options', async () => {
  const t = setup();
  await opened(t, CHIKA);
  await t.tap(CHIKA, 'see_reward');
  await t.tap(CHIKA, 'not_needed');
  await t.tap(CHIKA, 'fund');
  const text = t.last().text;
  assert.match(text, /account number 1100002265/);
  assert.match(text, /\*000\*1#/);
  assert.match(text, /branch or agent/);
  assert.ok(!t.sent.some((m) => m.type === 'cta' && /add-money/.test(m.url)), 'no app link for a customer without the app');
});

test('unknown app status: the agent asks before choosing a route', async () => {
  const t = setup();
  await opened(t, TOLU);
  await t.tap(TOLU, 'see_reward');
  await t.tap(TOLU, 'not_needed');
  await t.tap(TOLU, 'fund');
  assert.match(t.last().text, /Do you have the Olive MFB app/);
  await t.tap(TOLU, 'has_app_yes');
  assert.ok(t.sent.some((m) => m.type === 'cta' && /add-money/.test(m.url)));
});

test('free text is understood without a model, using keywords', async () => {
  const t = setup();
  await opened(t, ADA);
  await t.say(ADA, 'yes show me');
  await t.say(ADA, 'I moved to another bank, Kuda');
  assert.equal(t.store.getConversation(ADA).state, 'MOVED');
  await t.say(ADA, 'your fees are too high');
  assert.equal(t.store.getConversation(ADA).state, 'OFFER');
  assert.ok(t.gw.mock.audit.some((a) => a.action === 'record_feedback' && a.feedback === 'lower_fees'));
});

test('three replies it cannot understand hand the chat to a person', async () => {
  const t = setup();
  await opened(t, ADA);
  await t.say(ADA, 'qwerty');
  await t.say(ADA, 'asdfgh');
  await t.say(ADA, 'zxcvbn');
  assert.equal(t.store.getConversation(ADA).state, 'HANDED_OFF');
});

test('customer who writes first gets the opening options', async () => {
  const t = setup();
  await t.say(ADA, 'Hello');
  assert.equal(t.last().type, 'buttons');
  assert.equal(t.store.getConversation(ADA).state, 'OPEN');
});

test('unknown number gets a polite reply and no account details', async () => {
  const t = setup();
  await t.say('+2348099999999', 'hi');
  assert.match(t.last().text, /couldn’t find an Olive MFB account/);
});

test('remind me later schedules one reminder', async () => {
  const t = setup();
  await opened(t, ADA);
  await t.tap(ADA, 'see_reward');
  await t.tap(ADA, 'not_needed');
  await t.tap(ADA, 'later');
  const due = t.store.dueReminders(new Date(Date.now() + 4 * 86_400_000).toISOString());
  assert.equal(due.length, 1);
});

test('tapping Fund on a later reminder template reopens the funding step', async () => {
  const t = setup();
  await opened(t, ADA);
  await t.tap(ADA, 'see_reward');
  await t.tap(ADA, 'not_needed');
  await t.tap(ADA, 'later');
  await t.tap(ADA, 'fund');
  assert.ok(t.sent.some((m) => m.type === 'cta' && /add-money/.test(m.url)));
});
