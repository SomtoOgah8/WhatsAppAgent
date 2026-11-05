// Daily job: tells customers when their deposit lands, sends a halfway update,
// pays the reward when it's earned, and sends due reminders. Uses approved
// templates, because these messages usually fall outside WhatsApp's 24-hour window.
import { config } from './config.js';
import { log } from './log.js';

const naira = (n) => '₦' + Number(n).toLocaleString('en-NG');

export async function runRewardJob({ store, gw, wa, now = new Date() }) {
  const t = config.wa.templates;
  const summary = { checked: 0, deposit_notices: 0, progress_notices: 0, paid: 0, reminders: 0, errors: 0 };

  for (const { ref, phone } of store.enrolledRefs()) {
    summary.checked++;
    const conv = store.getConversation(phone);
    const name = (await gw.findCustomer(phone))?.first_name ?? 'there';
    try {
      const r = await gw.checkReward(ref);
      if ((r.status === 'qualifying' || r.status === 'met') && !store.noticeSent(ref, 'deposit')) {
        await wa.send(phone, { type: 'template', name: t.deposit, params: [name, naira(r.min_balance), String(r.days)] });
        store.markNotice(ref, 'deposit'); store.event(ref, 'deposit_notice_sent'); summary.deposit_notices++;
      }
      if (r.status === 'qualifying' && r.days_held >= Math.floor(r.days / 2) && !store.noticeSent(ref, 'progress')) {
        await wa.send(phone, { type: 'template', name: t.progress, params: [name, naira(r.min_balance), String(r.days - r.days_held)] });
        store.markNotice(ref, 'progress'); store.event(ref, 'progress_notice_sent'); summary.progress_notices++;
      }
      if (r.status === 'met') {
        const paid = await gw.payReward(ref, `${ref}:reward:${conv?.data?.offer?.id ?? 'offer'}`);
        if (!store.noticeSent(ref, 'paid')) {
          await wa.send(phone, { type: 'template', name: t.paid, params: [name, naira(paid.amount)] });
          store.markNotice(ref, 'paid'); store.event(ref, 'reward_paid', { amount: paid.amount, reference: paid.reference }); summary.paid++;
        }
      }
      if (r.status === 'broken' && !store.noticeSent(ref, 'broken')) {
        store.markNotice(ref, 'broken'); store.event(ref, 'reward_condition_broken'); // no nagging message
      }
    } catch (e) {
      summary.errors++;
      log.error('reward job error', { ref, error: e.message });
    }
  }

  for (const rem of store.dueReminders(now.toISOString())) {
    try {
      const c = await gw.findCustomer(rem.phone);
      if (!c || c.opted_out) { store.markReminderSent(rem.ref); continue; }
      await wa.send(rem.phone, { type: 'template', name: t.reminder, params: [c.first_name] });
      store.markReminderSent(rem.ref); store.event(rem.ref, 'reminder_sent'); summary.reminders++;
    } catch (e) { summary.errors++; log.error('reminder error', { ref: rem.ref, error: e.message }); }
  }
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { createStore } = await import('./store.js');
  const { createGatewayClient } = await import('./gateway.js');
  const { createWhatsAppClient } = await import('./whatsapp.js');
  const store = createStore(config.dbPath);
  const gw = createGatewayClient();
  const wa = createWhatsAppClient({ store, onSend: (to, m) => log.info('dry-run send', { to, template: m.name }) });
  console.log(JSON.stringify(await runRewardJob({ store, gw, wa }), null, 2));
}
