// Client for Olive's agent gateway. The agent can only do what this file
// exposes: no transfers, no full balances. "inprocess" mode uses the mock
// gateway directly for local runs and tests.
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { createMockGateway } from '../mock-gateway/logic.js';

export function createGatewayClient({ url = config.gateway.url, token = config.gateway.token, mock } = {}) {
  if (url === 'inprocess') {
    const gw = mock ?? createMockGateway();
    const wrap = (fn) => async (...a) => fn(...a);
    return {
      mode: 'inprocess',
      mock: gw,
      findCustomer: wrap((phone) => gw.findCustomer(phone)),
      listInactive: wrap(() => gw.listInactive({ consentOnly: true })),
      getAccountStatus: wrap((ref) => gw.getAccountStatus(ref)),
      startKycUpdate: wrap((ref) => gw.startKycUpdate(ref)),
      getAppLinks: wrap((ref) => gw.getAppLinks(ref)),
      getDepositDetails: wrap((ref) => gw.getDepositDetails(ref)),
      enrolReward: wrap((ref, offer) => gw.enrolReward(ref, offer)),
      checkReward: wrap((ref) => gw.checkReward(ref)),
      payReward: wrap((ref, key = randomUUID()) => gw.payReward(ref, key)),
      setOptOut: wrap((ref, v) => gw.setOptOut(ref, v)),
      recordFeedback: wrap((ref, f) => gw.recordFeedback(ref, f)),
      handoff: wrap((ref, s) => gw.handoff(ref, s)),
    };
  }

  async function call(method, path, body, headers = {}) {
    const res = await fetch(url.replace(/\/$/, '') + path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `gateway ${res.status}`); e.status = res.status; throw e; }
    return data;
  }
  const r = (ref) => encodeURIComponent(ref);
  return {
    mode: 'http',
    findCustomer: async (phone) => { const d = await call('POST', '/v1/customers/find', { phone }); return d.error ? null : d; },
    listInactive: () => call('GET', '/v1/customers/inactive'),
    getAccountStatus: (ref) => call('GET', `/v1/customers/${r(ref)}/status`),
    startKycUpdate: (ref) => call('POST', `/v1/customers/${r(ref)}/kyc-link`, {}),
    getAppLinks: (ref) => call('GET', `/v1/customers/${r(ref)}/app-links`),
    getDepositDetails: (ref) => call('GET', `/v1/customers/${r(ref)}/deposit-details`),
    enrolReward: (ref, offer_id) => call('POST', `/v1/customers/${r(ref)}/reward`, { offer_id }),
    checkReward: (ref) => call('GET', `/v1/customers/${r(ref)}/reward`),
    payReward: (ref, key = randomUUID()) => call('POST', `/v1/customers/${r(ref)}/reward/pay`, {}, { 'idempotency-key': key }),
    setOptOut: (ref, opted_out) => call('POST', `/v1/customers/${r(ref)}/opt-out`, { opted_out }),
    recordFeedback: (ref, feedback) => call('POST', `/v1/customers/${r(ref)}/feedback`, { feedback }),
    handoff: (ref, summary) => call('POST', `/v1/customers/${r(ref)}/handoff`, { summary }),
  };
}
