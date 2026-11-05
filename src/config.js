// Loads settings from the environment, after reading a local .env file if present.
import { readFileSync, existsSync } from 'node:fs';

function loadDotEnv(path = '.env') {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^['"]|['"]$/g, '');
  }
}
loadDotEnv();

const env = (k, d = '') => process.env[k] ?? d;

export const config = {
  port: Number(env('PORT', '8080')),
  dryRun: env('DRY_RUN', '1') === '1',
  dbPath: env('DB_PATH', './data/agent.sqlite'),
  wa: {
    apiVersion: env('WA_API_VERSION', 'v21.0'),
    phoneNumberId: env('WA_PHONE_NUMBER_ID'),
    accessToken: env('WA_ACCESS_TOKEN'),
    appSecret: env('WA_APP_SECRET'),
    verifyToken: env('WA_VERIFY_TOKEN'),
    templateLang: env('WA_TEMPLATE_LANG', 'en'),
    templates: {
      opening: env('WA_TEMPLATE_OPENING', 'olive_reactivation_opening'),
      deposit: env('WA_TEMPLATE_DEPOSIT', 'olive_reward_deposit_received'),
      progress: env('WA_TEMPLATE_PROGRESS', 'olive_reward_progress'),
      paid: env('WA_TEMPLATE_PAID', 'olive_reward_paid'),
      reminder: env('WA_TEMPLATE_REMINDER', 'olive_reward_reminder'),
    },
  },
  gateway: { url: env('GATEWAY_URL', 'inprocess'), token: env('GATEWAY_TOKEN', 'change-me') },
  llm: { apiKey: env('ANTHROPIC_API_KEY'), model: env('ANTHROPIC_MODEL', 'claude-haiku-5-5') },
  campaign: {
    id: env('CAMPAIGN_ID', 'pilot-1'),
    controlShare: Number(env('CONTROL_GROUP_SHARE', '0.3')),
    ratePerMinute: Number(env('SEND_RATE_PER_MINUTE', '30')),
  },
  mock: {
    port: Number(env('MOCK_GATEWAY_PORT', '8090')),
    token: env('MOCK_GATEWAY_TOKEN', 'change-me'),
    rewardDailyCap: Number(env('REWARD_DAILY_CAP_NGN', '50000')),
  },
};
