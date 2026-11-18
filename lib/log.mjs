import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

function maskToken(token) {
  if (token.startsWith("****")) return token;
  return token.length <= 8 ? "****" : "****" + token.slice(-4);
}

const TOKEN = "[A-Za-z0-9._~+/=-]{8,}";
const SENSITIVE_KEY = /^(authorization|x-api-key|api-key|apikey|token|secret|password|passwd|cookie|set-cookie)$/i;

// redact keeps a secret's last four characters so a reader can tell two
// keys apart, and nothing else. Known secrets go first by length, then the
// shapes a header or a key has.
export function redact(text, secrets = []) {
  let out = String(text ?? "");
  out = out.replace(/Authorization:\s*Bearer\s+([A-Za-z0-9._~+/=-]{8,})/gi, (_, token) => `Authorization: Bearer ${maskToken(token)}`);
  out = out.replace(new RegExp(`\\bBearer\\s+(${TOKEN})`, "gi"), (_, token) => `Bearer ${maskToken(token)}`);
  out = out.replace(new RegExp(`x-api-key:\\s*(${TOKEN})`, "gi"), (_, token) => `x-api-key: ${maskToken(token)}`);
  out = out.replace(/sk-magpie-[A-Za-z0-9_-]{8,}/g, (token) => maskToken(token));
  out = out.replace(/sk-[A-Za-z0-9_-]{16,}/g, (token) => maskToken(token));

  const known = [...new Set(secrets.filter((secret) => typeof secret === "string" && secret.length > 0))]
    .sort((a, b) => b.length - a.length);
  for (const secret of known) out = out.split(secret).join(maskToken(secret));
  return out;
}

// redactValue walks the entry before it is serialized: a header object
// such as {"x-api-key": "..."} never matches the text patterns above once
// it has quotes around the colon, so the values are masked by key name.
export function redactValue(value, secrets = []) {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, secrets));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key) && entry !== null && entry !== undefined) {
        out[key] = typeof entry === "string" ? maskToken(entry) : "****";
      } else {
        out[key] = redactValue(entry, secrets);
      }
    }
    return out;
  }
  return value;
}

function rotate(path, keep) {
  for (let i = keep; i >= 1; i--) {
    const src = i === 1 ? path : `${path}.${i - 1}`;
    const dst = `${path}.${i}`;
    try {
      if (i === keep && existsSync(dst)) unlinkSync(dst);
      if (existsSync(src)) renameSync(src, dst);
    } catch {
      // A log that cannot rotate is still better than a service that stops.
    }
  }
}

export function createLog({ path, maxBytes = 1 << 20, keep = 2, now = () => new Date(), secrets = [] }) {
  mkdirSync(dirname(path), { recursive: true });

  function event(kind, message, data = {}) {
    try {
      let known = [];
      try {
        known = typeof secrets === "function" ? secrets() : secrets;
      } catch {
        known = [];
      }
      const entry = redactValue({ at: now().toISOString(), kind, message, ...data }, known);
      const line = JSON.stringify(entry) + "\n";
      let size = 0;
      try {
        size = statSync(path).size;
      } catch {
        size = 0;
      }
      if (size > 0 && size + Buffer.byteLength(line, "utf8") > maxBytes) rotate(path, keep);
      appendFileSync(path, line, { mode: 0o600 });
    } catch {
      // Logging never takes the service down.
    }
  }

  function tail(n = 100) {
    if (!Number.isInteger(n) || n <= 0) return [];
    const files = [];
    for (let i = keep; i >= 1; i--) {
      if (existsSync(`${path}.${i}`)) files.push(`${path}.${i}`);
    }
    files.push(path);
    const entries = [];
    for (const file of files) {
      let text;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line));
        } catch {
          // A half-written line is skipped, not fatal.
        }
      }
    }
    return entries.slice(-n);
  }

  return { event, tail, path };
}
