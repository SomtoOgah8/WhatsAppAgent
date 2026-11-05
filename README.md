# Olive Reactivation Agent

A WhatsApp agent that helps inactive Olive MFB customers come back. It finds out why each customer went quiet, fixes what’s blocking them (login, KYC), and offers a reward for keeping a balance for 30 days. A mock Olive gateway with synthetic customers lets the whole thing run end to end without Meta or Olive access.

No third-party packages: Node.js 22.5 or later only (built-in web server, `fetch`, crypto, SQLite and test runner).

## Try it in two minutes

```bash
npm test          # 25 tests: flows, guardrails, rewards, webhook, gateway auth
npm run simulate  # chat with the agent in your terminal as a sample customer
```

In the simulator, type a number to tap an option or type a free-text reply. Extra commands: `/deposit 10000`, `/withdraw 8000`, `/days 15` (move the clock), `/rewards` (run the daily reward job), `/log` (what the agent did), `/quit`.

## How it fits together

```
WhatsApp ──▶ Agent service (src/server.js) ──▶ Olive agent gateway ──▶ Core banking
             conversation engine, guardrails     narrow API, owned by Olive IT
             campaign sender, reward job         (mock-gateway/ for testing)
```

| File | What it does |
|---|---|
| `src/server.js` | Webhook endpoint: Meta verification handshake, signature check on every call, de-duplicates retries, replies fast |
| `src/engine.js` | The conversation. Every customer-facing sentence is fixed, approved text in this file |
| `src/understand.js` | Maps free-text replies to the current step’s options. Keyword matching by default; Claude if `ANTHROPIC_API_KEY` is set. The model only picks an option; it never writes to customers |
| `src/guardrails.js` | Blocks PINs, OTPs, card and ID numbers coming in; blocks any outgoing message that asks for a secret or a payment; STOP, START and “talk to a person” |
| `src/whatsapp.js` | Cloud API client, payload builder with Meta’s limits, webhook parsing. `DRY_RUN=1` prints instead of sending |
| `src/gateway.js` | Client for Olive’s gateway. The agent can do only what this exposes: no transfers, no full balances |
| `src/campaign.js` | Sends the opening template to consenting inactive customers, with a stable control group |
| `src/rewards.js` | Daily job: deposit received, halfway update, pays the reward once (idempotent), due reminders |
| `src/store.js` | Conversation state, audit events, delivery status, campaign groups (SQLite) |
| `mock-gateway/` | Sandbox stand-in for Olive’s gateway, with synthetic customers and clock controls |
| `templates/templates.json` | The message templates to submit to Meta for approval |

## The gateway Olive IT needs to build

The agent never connects to core banking directly. Olive IT builds a small gateway in front of the sandbox (then production) with only these routes; `mock-gateway/server.js` is the reference implementation.

| Route | Purpose | Access |
|---|---|---|
| `POST /v1/customers/find` | Match a WhatsApp number to a customer; returns an internal reference, never the account number | Read |
| `GET /v1/customers/inactive` | Inactive customers who agreed to WhatsApp contact | Read |
| `GET /v1/customers/:ref/status` | Inactive since, KYC needed, restricted, has the app | Read |
| `POST /v1/customers/:ref/kyc-link` | Link to the secure KYC form | Read |
| `GET /v1/customers/:ref/app-links` | Deep links: reset login, add money | Read |
| `GET /v1/customers/:ref/deposit-details` | The customer’s own account number, USSD code and branch/agent locator, sent only to their registered number | Read |
| `POST /v1/customers/:ref/reward` · `GET …/reward` | Enrol in the offer · check progress | Low-risk write · Read |
| `POST /v1/customers/:ref/reward/pay` | Pay the cashback from a marketing GL. Requires `Idempotency-Key`; refuses unless earned; per-day cap | Tightly limited write |
| `POST /v1/customers/:ref/opt-out` · `…/feedback` · `…/handoff` | Opt-out, feedback, ticket for a human agent | Write |

Security between the systems: OAuth2 machine credentials or mutual TLS, IP allowlisting or VPN, rate limits, a full audit log, secrets in a vault. Maker-checker on reward payouts during the pilot.

## Going from local to the sandbox and the pilot

1. **Copy `.env.example` to `.env`.** Keep `DRY_RUN=1` until Meta is set up.
2. **Point at Olive’s sandbox gateway:** set `GATEWAY_URL` and `GATEWAY_TOKEN`. To rehearse over HTTP first, run `npm run gateway` and set `GATEWAY_URL=http://localhost:8090`.
3. **Meta set-up (done by Olive MFB):** verified Meta Business account, a WhatsApp number for the bank, an app with the WhatsApp product, a permanent access token. Fill `WA_PHONE_NUMBER_ID`, `WA_ACCESS_TOKEN`, `WA_APP_SECRET`, and choose a `WA_VERIFY_TOKEN`.
4. **Submit the templates** in `templates/templates.json` after Compliance signs off the wording.
5. **Deploy the service** behind HTTPS and set the webhook URL in Meta to `https://<host>/webhook` with your verify token; subscribe to `messages`.
6. **Test with Meta’s test number** and staff phones, then set `DRY_RUN=0`.
7. **Run the pilot:** `npm run campaign -- --limit=300`, and schedule `npm run rewards` once a day.
8. **Measure:** compare the outreach and control groups on accounts still active after 60–90 days, deposits held after 30 days, reward cost per account kept, opt-outs and complaints.

## Data protection

- The AI model, when used, receives only the customer’s reply text and the current options: no names, account numbers or balances.
- Logs mask phone numbers and long numbers. Messages that look like PINs, OTPs, card or ID numbers are refused and stored redacted.
- Only customers with WhatsApp consent are contacted; STOP works at any time and is respected by the campaign and reminders.
- Before production, Data Protection should confirm where the model provider processes data, and the hosting location for conversation data.

## Not included yet

- A screen for human support agents (hand-offs create a ticket in the gateway; replies would go through Olive’s helpdesk).
- Languages other than English for customer messages (the understanding step already accepts Pidgin keywords; full Yoruba, Hausa and Igbo copy needs translation and approval).
- A results dashboard for the pilot.
