// Conversation engine. Every customer-facing sentence is fixed, approved text
// in this file; the language model is only used to map free-text replies to
// the options of the current step (see understand.js).
import { detectSecret, redact, GLOBAL, assertSafeOutbound } from './guardrails.js';
import { understand } from './understand.js';
import { log } from './log.js';

const naira = (n) => '₦' + Number(n).toLocaleString('en-NG');
const SAFETY = 'Olive MFB will never ask for your PIN, OTP, password or card details.';

// Reply options used across steps.
const O = {
  see_reward: { id: 'see_reward', title: 'See my reward' },
  stop: { id: 'stop', title: 'Stop messages' },
  forgot_login: { id: 'forgot_login', title: 'I forgot my login' },
  restricted: { id: 'restricted', title: 'Account restricted' },
  moved_bank: { id: 'moved_bank', title: 'I moved to a new bank' },
  not_needed: { id: 'not_needed', title: 'Just haven’t needed it' },
  has_app_yes: { id: 'has_app_yes', title: 'Yes, I have it' },
  has_app_no: { id: 'has_app_no', title: 'No, I don’t' },
  login_done: { id: 'login_done', title: 'Done, I’m back in' },
  login_failed: { id: 'login_failed', title: 'It didn’t work' },
  kyc_submitted: { id: 'kyc_submitted', title: 'I’ve submitted it' },
  human: { id: 'human', title: 'Talk to a person' },
  better_rewards: { id: 'better_rewards', title: 'Better rewards' },
  lower_fees: { id: 'lower_fees', title: 'Lower fees' },
  faster_transfers: { id: 'faster_transfers', title: 'Faster transfers' },
  fund: { id: 'fund', title: 'Fund my account' },
  terms: { id: 'terms', title: 'See the terms' },
  later: { id: 'later', title: 'Remind me later' },
  fund_other: { id: 'fund_other', title: 'Other ways to pay' },
  funded: { id: 'funded', title: 'I’ve funded it' },
};

// Each step: enter() sends messages; options/next describe the replies it accepts.
// A step without options returns the name of the next step to run straight away.
export const steps = {
  OPEN: {
    options: [O.see_reward, O.stop],
    async enter(c) {
      await c.send({ type: 'buttons', text: `Hi ${c.customer.first_name}, it’s Olive MFB’s automated assistant. Your account has been quiet for a while and there’s a reward waiting for you.\n\n${SAFETY}`, buttons: [O.see_reward, O.stop] });
    },
    next: { see_reward: 'WHY', stop: 'STOP' },
  },
  WHY: {
    options: [O.forgot_login, O.restricted, O.moved_bank, O.not_needed],
    async enter(c) {
      await c.send({ type: 'list', text: 'Before I show you, a quick question so we can help properly: what stopped you using your account?', button: 'Choose an answer', rows: [O.forgot_login, O.restricted, O.moved_bank, O.not_needed] });
    },
    next: {
      forgot_login: (c) => { c.data.reason = 'forgot_login'; return c.needApp('LOGIN'); },
      restricted: (c) => { c.data.reason = 'restricted'; return 'KYC'; },
      moved_bank: (c) => { c.data.reason = 'moved_bank'; return 'MOVED'; },
      not_needed: (c) => { c.data.reason = 'not_needed'; return 'OFFER'; },
    },
  },
  ASK_APP: {
    options: [O.has_app_yes, O.has_app_no],
    async enter(c) { await c.send({ type: 'buttons', text: 'Do you have the Olive MFB app on this phone?', buttons: [O.has_app_yes, O.has_app_no] }); },
    next: {
      has_app_yes: (c) => { c.data.has_app = true; return c.data.after_app || 'OFFER'; },
      has_app_no: (c) => { c.data.has_app = false; return c.data.after_app || 'OFFER'; },
    },
  },
  LOGIN: {
    options: [O.login_done, O.login_failed, O.human],
    async enter(c) {
      if (c.hasApp()) {
        const links = await c.gw.getAppLinks(c.customer.ref);
        await c.send({ type: 'cta', text: `No problem. Reset your login securely in the Olive MFB app; it takes about a minute. I can’t see or reset it here. ${SAFETY}`, label: 'Reset login', url: links.reset_url });
        c.event('sent_reset_link');
        await c.send({ type: 'buttons', text: 'Let me know how it went.', buttons: [O.login_done, O.login_failed] });
      } else {
        const d = await c.gw.getDepositDetails(c.customer.ref);
        await c.send({ type: 'buttons', text: `No problem. You can reset your PIN by dialling ${d.ussd_code} and choosing “Reset PIN”, or at any Olive MFB branch or agent: ${d.agent_locator_url}\n\n${SAFETY}`, buttons: [O.login_done, O.human] });
        c.event('sent_ussd_reset_steps');
      }
    },
    next: { login_done: 'OFFER', login_failed: 'HUMAN', human: 'HUMAN' },
  },
  KYC: {
    options: [O.kyc_submitted, O.human],
    async enter(c) {
      const status = await c.gw.getAccountStatus(c.customer.ref);
      if (!status.kyc_required && !status.restricted) {
        await c.send({ type: 'text', text: 'Good news: your account isn’t restricted, so you can use it straight away.' });
        return 'OFFER';
      }
      const { url } = await c.gw.startKycUpdate(c.customer.ref);
      await c.send({ type: 'cta', text: 'Your account just needs your details updated: a valid ID and a quick selfie. It takes about 3 minutes in a secure form. Please don’t send ID photos or numbers in this chat.', label: 'Update my details', url });
      c.event('sent_kyc_link');
      await c.send({ type: 'buttons', text: 'Tell me when you’ve submitted it, or ask for a person if you’d like help.', buttons: [O.kyc_submitted, O.human] });
    },
    next: { kyc_submitted: 'KYC_DONE', human: 'HUMAN' },
  },
  KYC_DONE: {
    async enter(c) {
      await c.send({ type: 'text', text: `Thanks, ${c.customer.first_name}. We’ll check your details and confirm within 24 hours. Your account will be fully active again once they’re approved.` });
      c.event('kyc_submitted_reported');
      return 'OFFER';
    },
  },
  MOVED: {
    options: [O.better_rewards, O.lower_fees, O.faster_transfers, O.human],
    async enter(c) {
      await c.send({ type: 'list', text: 'Thanks for telling us. What would make Olive MFB worth using again?', button: 'Choose an answer', rows: [O.better_rewards, O.lower_fees, O.faster_transfers, O.human] });
    },
    next: {
      better_rewards: (c) => c.feedback('better_rewards'),
      lower_fees: (c) => c.feedback('lower_fees'),
      faster_transfers: (c) => c.feedback('faster_transfers'),
      human: 'HUMAN',
    },
  },
  OFFER: {
    options: [O.fund, O.terms, O.later],
    async enter(c) {
      const { offer } = await c.gw.enrolReward(c.customer.ref);
      c.data.enrolled = 1;
      c.data.offer = offer;
      c.event('reward_enrolled', { offer: offer.id });
      await c.send({ type: 'buttons', text: `Your reward: ${naira(offer.amount)} cashback.\n\nKeep ${naira(offer.min_balance)} or more in your account for ${offer.days} days, from the day you fund it. Fund it by ${offer.fund_by}.`, buttons: [O.fund, O.terms, O.later] });
    },
    next: { fund: (c) => c.needApp('FUND'), terms: 'TERMS', later: 'LATER' },
  },
  TERMS: {
    options: [O.fund, O.later],
    async enter(c) {
      const o = c.data.offer;
      await c.send({ type: 'buttons', text: `Terms: one reward per customer. Fund your account by ${o.fund_by} and keep a balance of at least ${naira(o.min_balance)} for ${o.days} days in a row. The ${naira(o.amount)} cashback is paid into your account within 2 working days after that. ${SAFETY}`, buttons: [O.fund, O.later] });
    },
    next: { fund: (c) => c.needApp('FUND'), later: 'LATER' },
  },
  FUND: {
    options: [O.funded, O.fund_other],
    async enter(c) {
      if (!c.hasApp()) return 'FUND_OTHER';
      const links = await c.gw.getAppLinks(c.customer.ref);
      await c.send({ type: 'cta', text: 'Add money to your account in the Olive MFB app. Nothing is paid in this chat.', label: 'Add money', url: links.add_money_url });
      c.event('sent_add_money_link');
      await c.send({ type: 'buttons', text: 'Prefer another way? You can also pay in by bank transfer, USSD or at a branch or agent.', buttons: [O.funded, O.fund_other] });
    },
    next: { funded: 'FUNDED', fund_other: 'FUND_OTHER' },
  },
  FUND_OTHER: {
    options: [O.funded, O.human],
    async enter(c) {
      const d = await c.gw.getDepositDetails(c.customer.ref);
      await c.send({ type: 'buttons', text: `Here’s how to fund your own Olive MFB account:\n\n• From any bank app: send money to ${d.bank_name}, account number ${d.account_number} (your account).\n• By USSD: dial ${d.ussd_code}.\n• In cash: at any Olive MFB branch or agent: ${d.agent_locator_url}\n\n${SAFETY}`, buttons: [O.funded, O.human] });
      c.event('sent_deposit_options');
    },
    next: { funded: 'FUNDED', human: 'HUMAN' },
  },
  FUNDED: {
    async enter(c) {
      const o = c.data.offer;
      await c.send({ type: 'text', text: `Thanks, ${c.customer.first_name}. I’ll message you as soon as your deposit arrives. Keep ${naira(o.min_balance)} or more for ${o.days} days and your ${naira(o.amount)} cashback is yours.` });
      return 'END';
    },
  },
  LATER: {
    async enter(c) {
      c.scheduleReminder(3);
      await c.send({ type: 'text', text: 'No problem. I’ll remind you in 3 days. Reply STOP any time to opt out.' });
      return 'END';
    },
  },
  STOP: {
    async enter(c) {
      await c.gw.setOptOut(c.customer.ref, true);
      c.event('opted_out');
      await c.send({ type: 'text', text: 'Done. You won’t get more messages like this. Reply START any time if you change your mind.' });
      return 'OPTED_OUT';
    },
  },
  HUMAN: {
    async enter(c) {
      const summary = `Reactivation chat. Reason: ${c.data.reason ?? 'not given'}. Reward enrolled: ${c.data.enrolled ? 'yes' : 'no'}. Last step: ${c.data.last_step ?? 'start'}.`;
      const { ticket_id } = await c.gw.handoff(c.customer.ref, summary);
      c.event('handed_off', { ticket_id });
      await c.send({ type: 'text', text: `I’ve passed this to a member of our support team (reference ${ticket_id}). They’ll reply here during working hours. You can also call Olive MFB on the number on our website to check it’s us.` });
      return 'HANDED_OFF';
    },
  },
  END: {
    options: [O.human],
    async enter(c) {
      await c.send({ type: 'buttons', text: 'Your reward is set up. I’ll message you with updates. Anything else?', buttons: [O.human] });
    },
    next: { human: 'HUMAN' },
  },
};

const PASSIVE = new Set(['OPTED_OUT', 'HANDED_OFF']);

export function createEngine({ store, gw, wa }) {
  async function run(phone, customer, conv, stepName, inbound) {
    const data = conv?.data ?? {};
    const ctx = {
      phone, customer, gw, data,
      send: async (m) => { assertSafeOutbound(m); await wa.send(phone, m); },
      event: (type, detail = {}) => store.event(customer.ref, type, detail),
      hasApp: () => (data.has_app ?? customer.has_app) === true,
      needApp: (after) => {
        if ((data.has_app ?? customer.has_app) === null || (data.has_app ?? customer.has_app) === undefined) { data.after_app = after; return 'ASK_APP'; }
        return after;
      },
      feedback: async (f) => {
        await gw.recordFeedback(customer.ref, f);
        store.event(customer.ref, 'feedback', { feedback: f });
        await wa.send(phone, { type: 'text', text: 'Noted, and passed on to our team. Here’s something to start with.' });
        return 'OFFER';
      },
      scheduleReminder: (days) => {
        store.scheduleReminder(customer.ref, phone, new Date(Date.now() + days * 86_400_000).toISOString());
        store.event(customer.ref, 'reminder_scheduled', { days });
      },
    };
    let name = stepName;
    for (let hops = 0; hops < 10 && name; hops++) {
      if (PASSIVE.has(name)) break;
      const step = steps[name];
      if (!step) throw new Error(`unknown step ${name}`);
      data.last_step = name;
      const next = await step.enter(ctx);
      if (typeof next === 'string') { name = next; continue; } // step chose to move on
      if (step.options) break; // wait for the customer's reply
      name = next;
    }
    store.saveConversation(phone, { ref: customer.ref, state: name, data, inbound });
    return name;
  }

  async function resolve(ctx, step, target) {
    return typeof target === 'function' ? await target(ctx) : target;
  }

  return {
    // Called by the campaign after the opening template is sent.
    async startedByTemplate(phone, customer) {
      store.saveConversation(phone, { ref: customer.ref, state: 'OPEN', data: { campaign: true } });
    },

    async handleInbound(msg) {
      const phone = msg.from;
      const customer = await gw.findCustomer(phone);
      if (!customer) {
        await wa.send(phone, { type: 'text', text: 'Hi, this is Olive MFB’s automated assistant for account offers. I couldn’t find an Olive MFB account linked to this number. For other help, please call Olive MFB or visit a branch.' });
        log.info('inbound from unknown number', { phone });
        return { state: null };
      }
      let conv = store.getConversation(phone);
      const state = conv?.state ?? null;
      const text = msg.text ?? '';

      // 1. Never process secrets. Warn and keep only a redacted record.
      if (msg.kind === 'text') {
        const secret = detectSecret(text);
        if (secret) {
          store.event(customer.ref, 'secret_blocked', { kind: secret, text: redact(text) });
          await wa.send(phone, { type: 'text', text: `Please don’t send PINs, OTPs, card or ID numbers in this chat. I’ve ignored that message. ${SAFETY} If you shared your PIN or OTP with anyone, change it in the app or call Olive MFB.` });
          return { state };
        }
      }

      // 2. Opt-out and opt-in always win.
      if (msg.kind === 'text' && GLOBAL.stop.test(text)) return { state: await run(phone, customer, conv, 'STOP', true) };
      if (msg.kind === 'text' && GLOBAL.start.test(text)) {
        await gw.setOptOut(customer.ref, false);
        store.event(customer.ref, 'opted_in');
        return { state: await run(phone, customer, conv, 'OPEN', true) };
      }
      if (state === 'OPTED_OUT' || customer.opted_out) { store.event(customer.ref, 'ignored_while_opted_out'); return { state: 'OPTED_OUT' }; }

      // 3. Asking for a person always works.
      if (msg.kind === 'text' && GLOBAL.human.test(text) && state !== 'HANDED_OFF') return { state: await run(phone, customer, conv, 'HUMAN', true) };
      if (state === 'HANDED_OFF') { store.event(customer.ref, 'message_for_support', { length: text.length }); store.saveConversation(phone, { ref: customer.ref, state, data: conv.data, inbound: true }); return { state }; }

      // 4. Template buttons can be tapped long after the chat moved on.
      if (msg.kind === 'reply' && msg.replyId === 'stop') return { state: await run(phone, customer, conv, 'STOP', true) };
      if (msg.kind === 'reply' && msg.replyId === 'fund' && conv?.data?.enrolled) {
        const v = conv.data.has_app ?? customer.has_app;
        if (v === null || v === undefined) conv.data.after_app = 'FUND';
        return { state: await run(phone, customer, conv, v === null || v === undefined ? 'ASK_APP' : 'FUND', true) };
      }

      // 5. No conversation yet: the customer wrote first.
      if (!state) return { state: await run(phone, customer, conv, 'OPEN', true) };

      // 6. Match the reply to the current step's options.
      const step = steps[state];
      if (!step?.options) return { state: await run(phone, customer, conv, 'END', true) };
      let choice = msg.kind === 'reply' ? msg.replyId : null;
      if (!step.options.some((o) => o.id === choice)) choice = msg.kind === 'text' ? await understand(text, step.options) : null;

      if (!choice || !(choice in (step.next ?? {}))) {
        const misses = (conv.data.misses ?? 0) + 1;
        conv.data.misses = misses;
        if (misses >= 3) { conv.data.misses = 0; return { state: await run(phone, customer, conv, 'HUMAN', true) }; }
        await wa.send(phone, { type: 'text', text: 'Sorry, I didn’t catch that. Please choose one of the options below, or type “agent” to talk to a person.' });
        return { state: await run(phone, customer, conv, state, true) };
      }
      conv.data.misses = 0;
      store.event(customer.ref, 'reply', { step: state, choice });
      const ctxForNext = {
        data: conv.data, customer,
        needApp: (after) => {
          const v = conv.data.has_app ?? customer.has_app;
          if (v === null || v === undefined) { conv.data.after_app = after; return 'ASK_APP'; }
          return after;
        },
        feedback: async (f) => {
          await gw.recordFeedback(customer.ref, f);
          store.event(customer.ref, 'feedback', { feedback: f });
          await wa.send(phone, { type: 'text', text: 'Noted, and passed on to our team. Here’s something to start with.' });
          return 'OFFER';
        },
      };
      const nextName = await resolve(ctxForNext, step, step.next[choice]);
      return { state: await run(phone, customer, conv, nextName, true) };
    },
  };
}
