// Mock Olive "agent gateway": the narrow API the agent is allowed to use.
// In production Olive IT builds this in front of the core banking system;
// the agent service talks to it the same way. All data here is synthetic.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const DAY = 86_400_000;

export const OFFER = {
  id: 'keep5k30',
  min_balance: 5000,
  days: 30,
  amount: 500,
  fund_by: '2026-11-30',
};

export function createMockGateway({ customers, rewardDailyCap = 50_000, now = () => Date.now() } = {}) {
  const seed = customers ?? JSON.parse(readFileSync(new URL('./customers.json', import.meta.url), 'utf8'));
  const db = new Map(seed.map((c) => [c.ref, { ...c, balance_history: [{ at: 0, balance: c.balance }], opted_out: false }]));
  const enrolments = new Map();
  const payouts = new Map(); // idempotency key -> result
  const audit = [];
  let clockOffset = 0;
  const clock = () => now() + clockOffset;

  const record = (action, ref, detail = {}) => audit.push({ at: new Date(clock()).toISOString(), action, ref, ...detail });
  const get = (ref) => {
    const c = db.get(ref);
    if (!c) { const e = new Error('unknown customer'); e.status = 404; throw e; }
    return c;
  };
  const normalise = (p) => String(p).replace(/[^\d]/g, '').replace(/^0(\d{10})$/, '234$1');

  function heldDays(c, enrolledAt) {
    // Days the balance has stayed at or above the minimum, counting from the
    // latest moment it rose to that level after enrolment.
    let since = null;
    for (const h of c.balance_history) {
      if (h.at < enrolledAt) { since = h.balance >= OFFER.min_balance ? enrolledAt : null; continue; }
      if (h.balance >= OFFER.min_balance) { if (since === null) since = h.at; } else since = null;
    }
    return since === null ? { held: 0, since: null } : { held: Math.floor((clock() - since) / DAY), since };
  }

  return {
    // --- reads ---
    findCustomer(phone) {
      const n = normalise(phone);
      for (const c of db.values()) if (normalise(c.phone) === n) {
        record('find_customer', c.ref);
        return { ref: c.ref, first_name: c.first_name, has_app: c.has_app, consent_whatsapp: c.consent_whatsapp, opted_out: c.opted_out };
      }
      return null;
    },
    listInactive({ consentOnly = true } = {}) {
      record('list_inactive', null);
      return [...db.values()]
        .filter((c) => (!consentOnly || c.consent_whatsapp) && !c.opted_out)
        .map((c) => ({ ref: c.ref, phone: c.phone, first_name: c.first_name, inactive_since: c.inactive_since }));
    },
    getAccountStatus(ref) {
      const c = get(ref);
      record('get_account_status', ref);
      return { inactive_since: c.inactive_since, kyc_required: c.kyc_required, restricted: c.restricted, has_app: c.has_app };
    },
    startKycUpdate(ref) {
      get(ref);
      record('start_kyc_update', ref);
      return { url: `https://secure.olivemfb.example/kyc/${randomUUID()}` };
    },
    getAppLinks(ref) {
      get(ref);
      return { reset_url: 'https://app.olivemfb.example/reset-login', add_money_url: 'https://app.olivemfb.example/add-money', download_url: 'https://olivemfb.example/app' };
    },
    getDepositDetails(ref) {
      const c = get(ref);
      record('get_deposit_details', ref);
      return { bank_name: 'Olive MFB', account_number: c.account_number, ussd_code: '*000*1#', agent_locator_url: 'https://olivemfb.example/find-us' };
    },
    checkReward(ref) {
      const c = get(ref);
      const e = enrolments.get(ref);
      if (!e) return { status: 'not_enrolled' };
      if (e.status === 'paid') return { status: 'paid', amount: e.amount };
      const { held, since } = heldDays(c, e.enrolled_at);
      const status = since === null ? (e.deposit_seen ? 'broken' : 'enrolled') : held >= OFFER.days ? 'met' : 'qualifying';
      return { status, days_held: held, qualifying_since: since ? new Date(since).toISOString() : null, min_balance: OFFER.min_balance, days: OFFER.days, amount: OFFER.amount };
    },
    // --- low-risk writes ---
    enrolReward(ref, offerId = OFFER.id) {
      get(ref);
      if (offerId !== OFFER.id) { const e = new Error('unknown offer'); e.status = 400; throw e; }
      if (!enrolments.has(ref)) enrolments.set(ref, { offer_id: offerId, enrolled_at: clock(), amount: OFFER.amount, status: 'enrolled', deposit_seen: false });
      record('enrol_reward', ref, { offer: offerId });
      return { ...enrolments.get(ref), offer: OFFER };
    },
    setOptOut(ref, optedOut) {
      get(ref).opted_out = Boolean(optedOut);
      record('set_opt_out', ref, { opted_out: Boolean(optedOut) });
      return { ok: true };
    },
    recordFeedback(ref, feedback) {
      get(ref);
      record('record_feedback', ref, { feedback });
      return { ok: true };
    },
    handoff(ref, summary) {
      const ticket_id = 'T-' + randomUUID().slice(0, 8).toUpperCase();
      record('handoff', ref, { ticket_id, summary: String(summary).slice(0, 500) });
      return { ticket_id };
    },
    // --- tightly limited write ---
    payReward(ref, idempotencyKey) {
      if (!idempotencyKey) { const e = new Error('idempotency key required'); e.status = 400; throw e; }
      if (payouts.has(idempotencyKey)) return payouts.get(idempotencyKey);
      const c = get(ref);
      const e = enrolments.get(ref);
      const status = this.checkReward(ref).status;
      if (!e || status !== 'met') { const err = new Error(`reward not due (status ${status})`); err.status = 409; throw err; }
      const today = new Date(clock()).toISOString().slice(0, 10);
      const paidToday = [...payouts.values()].filter((p) => p.paid && p.date === today).reduce((s, p) => s + p.amount, 0);
      if (paidToday + e.amount > rewardDailyCap) { const err = new Error('daily reward cap reached'); err.status = 429; throw err; }
      e.status = 'paid';
      c.balance += e.amount;
      c.balance_history.push({ at: clock(), balance: c.balance });
      const result = { paid: true, amount: e.amount, date: today, reference: 'RW-' + randomUUID().slice(0, 8).toUpperCase() };
      payouts.set(idempotencyKey, result);
      record('pay_reward', ref, { amount: e.amount, reference: result.reference });
      return result;
    },
    // --- sandbox-only helpers (never in production) ---
    sim: {
      deposit(ref, amount) {
        const c = get(ref);
        c.balance += Number(amount);
        c.balance_history.push({ at: clock(), balance: c.balance });
        const e = enrolments.get(ref);
        if (e) e.deposit_seen = true;
        record('sim_deposit', ref, { amount: Number(amount) });
        return { balance: c.balance };
      },
      withdraw(ref, amount) {
        const c = get(ref);
        c.balance = Math.max(0, c.balance - Number(amount));
        c.balance_history.push({ at: clock(), balance: c.balance });
        record('sim_withdraw', ref, { amount: Number(amount) });
        return { balance: c.balance };
      },
      advanceDays(n) { clockOffset += Number(n) * DAY; return { now: new Date(clock()).toISOString() }; },
      now: () => new Date(clock()).toISOString(),
      depositSeen: (ref) => Boolean(enrolments.get(ref)?.deposit_seen),
    },
    audit,
  };
}
