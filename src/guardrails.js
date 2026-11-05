// Safety checks on what customers send and what the agent sends back.

// Customer messages that look like they contain a secret.
const SECRET_HINT = /\b(pin|otp|password|passcode|token|cvv|code)\b/i;
const CARD = /\b(?:\d[ -]?){13,19}\b/;
const OTP_LIKE = /\b\d{4,8}\b/;
const BVN_NIN = /\b\d{11}\b/;

export function detectSecret(text = '') {
  if (CARD.test(text)) return 'card';
  if (BVN_NIN.test(text)) return 'id_number';
  if (OTP_LIKE.test(text) && SECRET_HINT.test(text)) return 'pin_or_otp';
  if (/^\s*\d{4,6}\s*$/.test(text)) return 'pin_or_otp'; // a bare 4–6 digit number
  return null;
}

export function redact(text = '') {
  return text.replace(/\d/g, '•');
}

// Outbound safety net: the agent must never ask for these.
const FORBIDDEN_ASKS = [
  /(send|share|tell|give|enter|type)\b[^.?!]{0,40}\b(pin|otp|password|cvv|card number)/i,
  /\btransfer\b[^.?!]{0,40}\bto (this|the following|our) (account|number)/i,
];
export function assertSafeOutbound(m) {
  const text = [m.text, ...(m.buttons ?? []).map((b) => b.title), ...(m.rows ?? []).map((r) => r.title)].filter(Boolean).join(' ');
  // Check sentence by sentence; warnings such as "never share your PIN" are allowed.
  for (const sentence of text.split(/(?<=[.?!])\s+/)) {
    if (/\b(never|don[’']t|do not|won[’']t|will not)\b/i.test(sentence)) continue;
    for (const re of FORBIDDEN_ASKS) if (re.test(sentence)) throw new Error('blocked outbound message: asks for a secret or a payment');
  }
  return m;
}

// Words that mean "stop", "start" or "get me a person", in English and Pidgin.
export const GLOBAL = {
  stop: /^\s*(stop|unsubscribe|opt out|no more|leave me|abeg stop)\s*\.?\s*$/i,
  start: /^\s*(start|subscribe|opt in)\s*\.?\s*$/i,
  human: /\b(agent|human|person|customer (care|service|support)|talk to (someone|somebody)|call me)\b/i,
};
