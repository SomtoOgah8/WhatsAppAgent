// Structured JSON logs. Phone numbers and anything that looks like an account
// number, PIN, OTP or card number are masked before a line is written.
const PHONE = /\+?234\d{10}|\b0\d{10}\b/g;
const LONG_DIGITS = /\b\d{4,}\b/g;

export function mask(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(PHONE, (p) => p.slice(0, 4) + '•••••' + p.slice(-3))
    .replace(LONG_DIGITS, (d) => (d.length >= 4 ? '•'.repeat(d.length - 2) + d.slice(-2) : d));
}

function scrub(obj) {
  if (obj == null) return obj;
  if (typeof obj === 'string') return mask(obj);
  if (Array.isArray(obj)) return obj.map(scrub);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = /token|secret|key/i.test(k) ? '[hidden]' : scrub(v);
    return out;
  }
  return obj;
}

export const log = {
  info: (msg, data = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), level: 'info', msg, ...scrub(data) })),
  warn: (msg, data = {}) => console.warn(JSON.stringify({ t: new Date().toISOString(), level: 'warn', msg, ...scrub(data) })),
  error: (msg, data = {}) => console.error(JSON.stringify({ t: new Date().toISOString(), level: 'error', msg, ...scrub(data) })),
};
