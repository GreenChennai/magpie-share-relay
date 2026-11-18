import { existsSync } from "node:fs";
import { runCommand } from "./exec.mjs";
import { redact } from "./log.mjs";

export function parseKeyList(text) {
  const rows = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^ID\s+NAME\b/.test(line) || /^ID\s{2,}/.test(line)) continue;

    const cols = line.split(/\s{2,}/);
    if (cols.length < 4) continue;

    const id = cols[0];
    const nameField = cols[1] || "";
    let name = nameField;
    let state = "";
    let rest = cols.slice(2);

    // A short name leaves only one space before STATE, so the two columns
    // arrive merged; a long name leaves them separate.
    const merged = /^(.*\S)\s+(enabled|disabled|revoked|limited)$/i.exec(nameField);
    if (merged) {
      name = merged[1];
      state = merged[2];
    } else {
      state = rest.shift() || "";
    }

    const [masked, limit, models, accounts, access] = rest;
    if (!id || !name) continue;
    rows.push({
      id,
      name,
      state,
      masked: masked || "",
      limit: limit || "",
      models: models || "",
      accounts: accounts || "",
      access: access || "",
    });
  }
  return rows;
}

export function findKeyByName(rows, name) {
  return (rows || []).find((row) => row?.name === name) || null;
}

export function parseSecret(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines.at(-1) || "";
  if (!/^[A-Za-z0-9._-]{16,}$/.test(last)) {
    throw new Error("magpie did not print a gateway key secret");
  }
  return last;
}

export function maskSecret(secret) {
  const value = typeof secret === "string" ? secret : "";
  return value.length <= 8 ? "****" : "****" + value.slice(-4);
}

// /v1/magpie/limit puts the figures under `limit`; older responses put them
// at the top level. Accept both so the page shows what the key has left.
export function limitState(json = {}) {
  const source = json && typeof json.limit === "object" && json.limit ? json.limit : (json || {});
  return {
    limited: json?.limited ?? null,
    period: source.period ?? "",
    reset: source.reset ?? "",
    tokensLeft: source.tokensLeft ?? null,
    costLeft: source.costLeft ?? null,
  };
}

export function createMagpie({ bin = "magpie", run = runCommand } = {}) {
  async function invoke(args, options = {}) {
    const result = await run([bin, "gateway-key", ...args], { timeoutMs: 15000, ...options });
    if (result.code !== 0) {
      // stdout can carry a freshly printed secret; only stderr is reported,
      // and even that is passed through the redactor.
      const detail = redact(String(result.stderr || "").trim());
      throw new Error(`magpie gateway-key ${args[0]} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`);
    }
    return result;
  }

  async function add(name) {
    return parseSecret((await invoke(["add", name])).stdout);
  }

  async function list() {
    return parseKeyList((await invoke(["list"])).stdout);
  }

  async function limitOff(id) {
    await invoke(["limit", id, "off"]);
  }

  async function limit(id, spec = {}) {
    const period = spec.period || "day";
    if (!["day", "week", "month"].includes(period)) {
      throw new Error("limit period must be day, week or month");
    }
    await limitOff(id);
    const args = ["limit", id, period];
    if (spec.costUsd !== undefined && spec.costUsd !== null) args.push("--cost", String(spec.costUsd));
    if (Number(spec.tokens) > 0) args.push("--tokens", String(spec.tokens));
    await invoke(args);
  }

  async function remove(id) {
    await invoke(["remove", id]);
  }

  async function rotate(id) {
    return parseSecret((await invoke(["rotate", id])).stdout);
  }

  return { add, list, limit, limitOff, remove, rotate };
}

export async function findMagpie({
  configured = "",
  ppid = process.ppid,
  run = runCommand,
  platform = process.platform,
  exists = existsSync,
} = {}) {
  const works = async (candidate) => {
    if (!candidate) return false;
    try {
      const result = await run([candidate, "gateway-key", "list"], { timeoutMs: 5000 });
      return result.code === 0;
    } catch {
      return false;
    }
  };

  if (configured && await works(configured)) return configured;

  if (platform === "win32" && ppid) {
    const parent = await run([
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${Number(ppid)}).Path`,
    ], { timeoutMs: 8000 }).catch(() => ({ code: 1, stdout: "" }));
    const path = String(parent.stdout || "").trim();
    if (path) {
      const com = path.replace(/\.exe$/i, ".com");
      if (/\.exe$/i.test(path) && exists(com) && await works(com)) return com;
      if (await works(path)) return path;
    }
  }

  const finder = platform === "win32" ? "where.exe" : "which";
  const found = await run([finder, "magpie"], { timeoutMs: 5000 }).catch(() => ({ code: 1, stdout: "" }));
  let candidates = String(found.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (platform === "win32") {
    candidates = [
      ...candidates.filter((line) => /\.com$/i.test(line)),
      ...candidates.filter((line) => !/\.com$/i.test(line)),
    ];
  }
  for (const candidate of candidates) {
    if (await works(candidate)) return candidate;
  }
  return "magpie";
}
