// Sends the opening template to inactive customers who agreed to be contacted,
// holding back a control group that receives nothing.
import { createHash } from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';

// Same customer, same campaign -> same group, every run.
export function assignGroup(ref, campaignId, controlShare) {
  const h = createHash('sha256').update(`${campaignId}:${ref}`).digest();
  return h.readUInt32BE(0) / 0xffffffff < controlShare ? 'control' : 'outreach';
}

export async function runCampaign({ store, gw, wa, engine, campaignId = config.campaign.id, controlShare = config.campaign.controlShare, limit = Infinity, ratePerMinute = config.campaign.ratePerMinute, pause = !config.dryRun }) {
  const people = (await gw.listInactive()).slice(0, limit);
  const summary = { campaignId, total: people.length, outreach: 0, control: 0, sent: 0, skipped: 0, failed: 0 };
  for (const p of people) {
    const grp = assignGroup(p.ref, campaignId, controlShare);
    store.addCampaignMember(campaignId, { ref: p.ref, phone: p.phone, grp });
    summary[grp]++;
    if (grp === 'control') continue;
    const already = store.campaignMembers(campaignId).find((m) => m.ref === p.ref)?.sent_at;
    if (already) { summary.skipped++; continue; }
    try {
      await wa.send(p.phone, { type: 'template', name: config.wa.templates.opening, params: [p.first_name] });
      store.markCampaignSent(campaignId, p.ref);
      await engine.startedByTemplate(p.phone, { ref: p.ref, first_name: p.first_name });
      store.event(p.ref, 'opening_sent', { campaignId });
      summary.sent++;
    } catch (e) {
      summary.failed++;
      log.error('opening send failed', { ref: p.ref, error: e.message });
    }
    if (pause) await new Promise((r) => setTimeout(r, Math.ceil(60_000 / ratePerMinute)));
  }
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { createStore } = await import('./store.js');
  const { createGatewayClient } = await import('./gateway.js');
  const { createWhatsAppClient } = await import('./whatsapp.js');
  const { createEngine } = await import('./engine.js');
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const store = createStore(config.dbPath);
  const gw = createGatewayClient();
  const wa = createWhatsAppClient({ store, onSend: (to, m) => log.info('dry-run send', { to, template: m.name }) });
  const engine = createEngine({ store, gw, wa });
  const summary = await runCampaign({ store, gw, wa, engine, limit: limitArg ? Number(limitArg.split('=')[1]) : Infinity });
  console.log(JSON.stringify(summary, null, 2));
}
