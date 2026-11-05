import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, ADA } from './helpers.js';
import { runRewardJob } from '../src/rewards.js';
import { createMockGateway } from '../mock-gateway/logic.js';
import { createGatewayServer } from '../mock-gateway/server.js';
import { createGatewayClient } from '../src/gateway.js';

async function enrolAda(t) {
  await t.engine.startedByTemplate(ADA, await t.gw.findCustomer(ADA));
  await t.tap(ADA, 'see_reward');
  await t.tap(ADA, 'not_needed');
  return (await t.gw.findCustomer(ADA)).ref;
}
const job = (t) => runRewardJob({ ...t, now: new Date(t.gw.mock.sim.now()) });

test('full reward lifecycle: deposit notice, halfway notice, payment once', async () => {
  const t = setup();
  const ref = await enrolAda(t);
  assert.equal((await job(t)).deposit_notices, 0, 'nothing before a deposit');
  t.gw.mock.sim.deposit(ref, 10_000);
  assert.equal((await job(t)).deposit_notices, 1);
  t.gw.mock.sim.advanceDays(16);
  assert.equal((await job(t)).progress_notices, 1);
  t.gw.mock.sim.advanceDays(15);
  assert.equal((await job(t)).paid, 1);
  const second = await job(t);
  assert.equal(second.paid, 0, 'never paid twice');
  assert.equal(t.gw.mock.audit.filter((a) => a.action === 'pay_reward').length, 1);
});

test('withdrawing below the minimum breaks the streak and no reward is paid', async () => {
  const t = setup();
  const ref = await enrolAda(t);
  t.gw.mock.sim.deposit(ref, 10_000);
  t.gw.mock.sim.advanceDays(10);
  t.gw.mock.sim.withdraw(ref, 9_000);
  t.gw.mock.sim.advanceDays(25);
  const s = await job(t);
  assert.equal(s.paid, 0);
  assert.equal((await t.gw.checkReward(ref)).status, 'broken');
});

test('gateway refuses early payment, needs an idempotency key and enforces the daily cap', () => {
  const gw = createMockGateway({ rewardDailyCap: 500 });
  assert.throws(() => gw.payReward('C-1001'), /idempotency/);
  gw.enrolReward('C-1001'); gw.enrolReward('C-1006');
  assert.throws(() => gw.payReward('C-1001', 'k1'), /not due/);
  gw.sim.deposit('C-1001', 6000); gw.sim.deposit('C-1006', 6000);
  gw.sim.advanceDays(31);
  const first = gw.payReward('C-1001', 'k1');
  assert.deepEqual(gw.payReward('C-1001', 'k1'), first, 'same key returns the same result');
  assert.throws(() => gw.payReward('C-1006', 'k2'), /daily reward cap/);
});

test('agent works against the gateway over HTTP with bearer auth', async () => {
  const server = createGatewayServer(createMockGateway(), 'tok');
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const gw = createGatewayClient({ url, token: 'tok' });
    const c = await gw.findCustomer('+2348030000001');
    assert.equal(c.first_name, 'Ada');
    assert.equal(c.account_number, undefined, 'lookup never returns the account number');
    const status = await gw.getAccountStatus(c.ref);
    assert.equal(status.kyc_required, false);
    await assert.rejects(createGatewayClient({ url, token: 'bad' }).getAccountStatus(c.ref), /unauthorised/);
  } finally { server.close(); }
});
