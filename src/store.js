// Local state for the agent service, in SQLite (Node's built-in driver).
// For production, swap for Olive's managed database; the interface stays the same.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function createStore(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS conversations (phone TEXT PRIMARY KEY, ref TEXT, state TEXT, data TEXT, last_inbound_at TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS processed_messages (id TEXT PRIMARY KEY, at TEXT);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, ref TEXT, type TEXT, detail TEXT);
    CREATE TABLE IF NOT EXISTS outbound (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, to_phone TEXT, kind TEXT, payload TEXT, wa_message_id TEXT, status TEXT);
    CREATE TABLE IF NOT EXISTS campaign_members (campaign_id TEXT, ref TEXT, phone TEXT, grp TEXT, sent_at TEXT, delivery TEXT, PRIMARY KEY (campaign_id, ref));
    CREATE TABLE IF NOT EXISTS reward_notices (ref TEXT, kind TEXT, at TEXT, PRIMARY KEY (ref, kind));
    CREATE TABLE IF NOT EXISTS reminders (ref TEXT PRIMARY KEY, phone TEXT, due_at TEXT, sent_at TEXT);
  `);
  const now = () => new Date().toISOString();
  const q = (sql) => db.prepare(sql);

  return {
    db,
    getConversation(phone) {
      const row = q('SELECT * FROM conversations WHERE phone = ?').get(phone);
      return row ? { ...row, data: JSON.parse(row.data || '{}') } : null;
    },
    saveConversation(phone, { ref, state, data, inbound = false }) {
      const prev = this.getConversation(phone);
      q(`INSERT INTO conversations (phone, ref, state, data, last_inbound_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(phone) DO UPDATE SET ref=excluded.ref, state=excluded.state, data=excluded.data,
         last_inbound_at=COALESCE(excluded.last_inbound_at, conversations.last_inbound_at), updated_at=excluded.updated_at`)
        .run(phone, ref ?? prev?.ref ?? null, state, JSON.stringify(data ?? prev?.data ?? {}), inbound ? now() : null, now());
    },
    markProcessed(id) {
      try { q('INSERT INTO processed_messages (id, at) VALUES (?, ?)').run(id, now()); return true; }
      catch { return false; } // already seen: WhatsApp retries webhooks
    },
    event(ref, type, detail = {}) { q('INSERT INTO events (at, ref, type, detail) VALUES (?, ?, ?, ?)').run(now(), ref ?? null, type, JSON.stringify(detail)); },
    events(ref) { return q('SELECT * FROM events WHERE ref = ? ORDER BY id').all(ref).map((e) => ({ ...e, detail: JSON.parse(e.detail) })); },
    outbound(to, kind, payload, waId = null) {
      q('INSERT INTO outbound (at, to_phone, kind, payload, wa_message_id, status) VALUES (?, ?, ?, ?, ?, ?)').run(now(), to, kind, JSON.stringify(payload), waId, 'sent');
    },
    setDelivery(waId, status) {
      q('UPDATE outbound SET status = ? WHERE wa_message_id = ?').run(status, waId);
      const row = q('SELECT to_phone FROM outbound WHERE wa_message_id = ?').get(waId);
      if (row) q('UPDATE campaign_members SET delivery = ? WHERE phone = ? AND (delivery IS NULL OR delivery != ?)').run(status, row.to_phone, 'not_on_whatsapp');
      return row?.to_phone ?? null;
    },
    addCampaignMember(campaignId, m) {
      q('INSERT OR IGNORE INTO campaign_members (campaign_id, ref, phone, grp, sent_at, delivery) VALUES (?, ?, ?, ?, NULL, NULL)').run(campaignId, m.ref, m.phone, m.grp);
    },
    campaignMembers(campaignId) { return q('SELECT * FROM campaign_members WHERE campaign_id = ?').all(campaignId); },
    markCampaignSent(campaignId, ref) { q('UPDATE campaign_members SET sent_at = ?, delivery = ? WHERE campaign_id = ? AND ref = ?').run(now(), 'sent', campaignId, ref); },
    noticeSent(ref, kind) { return Boolean(q('SELECT 1 FROM reward_notices WHERE ref = ? AND kind = ?').get(ref, kind)); },
    markNotice(ref, kind) { q('INSERT OR IGNORE INTO reward_notices (ref, kind, at) VALUES (?, ?, ?)').run(ref, kind, now()); },
    scheduleReminder(ref, phone, dueAt) { q('INSERT INTO reminders (ref, phone, due_at, sent_at) VALUES (?, ?, ?, NULL) ON CONFLICT(ref) DO UPDATE SET due_at = excluded.due_at, sent_at = NULL').run(ref, phone, dueAt); },
    dueReminders(at) { return q('SELECT * FROM reminders WHERE sent_at IS NULL AND due_at <= ?').all(at); },
    markReminderSent(ref) { q('UPDATE reminders SET sent_at = ? WHERE ref = ?').run(now(), ref); },
    enrolledRefs() {
      return q(`SELECT ref, phone FROM conversations WHERE ref IS NOT NULL AND json_extract(data, '$.enrolled') = 1`).all();
    },
  };
}
