import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { serverNameOf } from "./nginx.mjs";

export { configPaths } from "./paths.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const packageOptions = pkg.magpie?.options ?? {};
const { port: _servicePort, ...defaults } = packageOptions;
const DEFAULT_CONFIG = defaults;

const SSH_KEYS = ["host", "port", "user", "keyPath", "fingerprint", "sudo"];
const NGINX_KEYS = ["configRoot", "snippetPath", "lastAppliedAt"];
const TOP_KEYS = ["version", "enabled", "autoStart", "publicURL", "remotePort", "gatewayPort", "lanIP", "magpieBin"];

function pick(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

export function normalizeConfig(raw = {}) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config must be a JSON object");
  }
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg, pick(raw, TOP_KEYS));
  if (raw.ssh !== undefined) {
    if (raw.ssh === null || typeof raw.ssh !== "object" || Array.isArray(raw.ssh)) {
      throw new Error("config.ssh must be an object");
    }
    cfg.ssh = { ...cfg.ssh, ...pick(raw.ssh, SSH_KEYS) };
  }
  if (raw.nginx !== undefined) {
    if (raw.nginx === null || typeof raw.nginx !== "object" || Array.isArray(raw.nginx)) {
      throw new Error("config.nginx must be an object");
    }
    cfg.nginx = { ...cfg.nginx, ...pick(raw.nginx, NGINX_KEYS) };
  }
  if (raw.invites !== undefined) {
    if (!Array.isArray(raw.invites)) throw new Error("config.invites must be an array");
    cfg.invites = structuredClone(raw.invites);
  }
  if (!Number.isInteger(cfg.remotePort) || cfg.remotePort < 1 || cfg.remotePort > 65535) {
    throw new Error("config.remotePort must be an integer between 1 and 65535");
  }
  let publicURL;
  try {
    publicURL = new URL(cfg.publicURL);
  } catch {
    throw new Error("config.publicURL must be an http(s) URL");
  }
  if (publicURL.protocol !== "http:" && publicURL.protocol !== "https:") {
    throw new Error("config.publicURL must be an http(s) URL");
  }
  try {
    serverNameOf(cfg.publicURL);
  } catch {
    throw new Error("config.publicURL must have a plain DNS hostname");
  }
  return cfg;
}

function markRecovered(cfg) {
  Object.defineProperty(cfg, "recoveredFromBackup", { value: true, enumerable: false });
  return cfg;
}

export async function loadConfig(paths, seed = {}) {
  await mkdir(paths.dataDir, { recursive: true });
  let text;
  try {
    text = await readFile(paths.configPath, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    const cfg = normalizeConfig(seed);
    await saveConfig(paths, cfg);
    return cfg;
  }
  let firstError;
  try {
    return normalizeConfig(JSON.parse(text));
  } catch (err) {
    firstError = err;
  }
  let backupText;
  try {
    backupText = await readFile(paths.backupPath, "utf8");
  } catch (err) {
    throw new Error(`config ${paths.configPath} is invalid (${firstError.message}) and ${paths.backupPath} cannot be read (${err.message})`);
  }
  try {
    return markRecovered(normalizeConfig(JSON.parse(backupText)));
  } catch (err) {
    throw new Error(`config ${paths.configPath} is invalid (${firstError.message}) and ${paths.backupPath} is invalid (${err.message})`);
  }
}

export async function saveConfig(paths, config) {
  const cfg = normalizeConfig(config);
  await mkdir(paths.dataDir, { recursive: true });
  let current = null;
  try {
    current = await readFile(paths.configPath, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (current !== null) {
    let valid = true;
    try {
      normalizeConfig(JSON.parse(current));
    } catch {
      valid = false;
    }
    if (valid) {
      // Keep the last good config as the backup.
      await copyFile(paths.configPath, paths.backupPath);
    } else {
      // Never let a corrupt file overwrite the only good backup.
      await copyFile(paths.configPath, `${paths.configPath}.corrupt.${Date.now()}`);
    }
  }
  const tmp = paths.configPath + ".tmp." + process.pid;
  await writeFile(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, paths.configPath);
}
