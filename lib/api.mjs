import { readFile } from "node:fs/promises";
import { normalizeConfig } from "./config.mjs";
import { buildLinks } from "./links.mjs";
import { maskSecret } from "./magpie.mjs";
import { buildApplyScript, includeLine, renderSnippet, serverNameOf } from "./nginx.mjs";
import { getJSON } from "./probe.mjs";
import { authorizeCommand, ensureKey } from "./ssh.mjs";

const SSH_FIELDS = ["host", "port", "user", "keyPath", "fingerprint", "sudo"];
const NGINX_FIELDS = ["configRoot", "snippetPath"];
const CONFIG_FIELDS = ["autoStart", "publicURL", "remotePort", "gatewayPort", "lanIP", "magpieBin"];

function pick(source, fields) {
  const out = {};
  for (const field of fields) {
    if (source && source[field] !== undefined) out[field] = source[field];
  }
  return out;
}

function runtimeView(runtime = {}) {
  return {
    primary: runtime.primary ?? runtime.isPrimary ?? false,
    hasLock: runtime.hasLock ?? false,
    servicePort: runtime.servicePort ?? runtime.port ?? 0,
    configuredPort: runtime.configuredPort ?? 0,
  };
}

export function maskedState(config = {}, runtime = {}, relay = runtime?.relay) {
  const invites = (config.invites || []).map(({ secret, ...rest }) => ({
    ...rest,
    secretMasked: maskSecret(secret),
  }));

  let links = null;
  try {
    links = buildLinks(config.publicURL);
  } catch {
    links = null;
  }

  return {
    enabled: Boolean(config.enabled),
    autoStart: Boolean(config.autoStart),
    publicURL: config.publicURL,
    remotePort: config.remotePort,
    gatewayPort: config.gatewayPort,
    lanIP: config.lanIP,
    magpieBin: config.magpieBin,
    ssh: pick(config.ssh, SSH_FIELDS),
    nginx: pick(config.nginx, ["configRoot", "snippetPath", "lastAppliedAt"]),
    invites,
    runtime: runtimeView(runtime),
    relay: relay?.status?.() ?? null,
    links,
    checks: runtime?.preflight?.checks || null,
    checksAt: runtime?.preflight?.at || null,
    publicCheck: runtime?.lastPublicCheck || null,
    publicCheckAt: runtime?.lastPublicCheckAt || null,
    configRecovered: Boolean(runtime?.configRecovered),
  };
}

async function sshFields(paths, ssh = {}) {
  const keyPath = ssh.keyPath || paths?.keyPath;
  const pubKeyPath = ssh.keyPath ? `${ssh.keyPath}.pub` : paths?.pubKeyPath;
  if (!pubKeyPath) return { sshPublicKey: "", authorizeCommand: "" };
  let publicKey = "";
  try {
    publicKey = (await readFile(pubKeyPath, "utf8")).trim();
  } catch {
    publicKey = "";
  }
  if (!publicKey && keyPath) {
    try {
      publicKey = (await ensureKey({ keyPath })).publicKey;
    } catch {
      publicKey = "";
    }
  }
  return {
    sshPublicKey: publicKey,
    authorizeCommand: publicKey ? authorizeCommand(publicKey) : "",
  };
}

function firstFatal(checks = []) {
  return checks.find((check) => check.fatal && !check.ok) || null;
}

function maskInvite(invite = {}) {
  const { secret, ...rest } = invite;
  return { ...rest, secretMasked: invite.secretMasked || maskSecret(secret) };
}

function replaceInvite(config, invite) {
  const invites = (config.invites || []).map((entry) => (entry.id === invite.id ? invite : entry));
  return normalizeConfig({ ...config, invites });
}

function normalizeLimit(raw) {
  const limit = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { period: "day", costUsd: 5 };
  const period = limit.period || "day";
  if (!["day", "week", "month"].includes(period)) {
    throw new Error("limit.period must be day, week or month");
  }
  const out = { period };
  if (limit.costUsd !== undefined) {
    const cost = Number(limit.costUsd);
    if (!Number.isFinite(cost) || cost < 0) throw new Error("limit.costUsd must be a non-negative number");
    out.costUsd = cost;
  }
  if (limit.tokens !== undefined) {
    const tokens = Number(limit.tokens);
    if (!Number.isInteger(tokens) || tokens < 0) throw new Error("limit.tokens must be a non-negative integer");
    out.tokens = tokens;
  }
  return out;
}

function defaultPreview(config) {
  const snippetPath = config.nginx?.snippetPath || "/etc/nginx/snippets/magpie-share.conf";
  const configRoot = config.nginx?.configRoot || "/etc/nginx";
  const snippet = renderSnippet({ publicURL: config.publicURL, remotePort: config.remotePort });
  return {
    snippet,
    include: includeLine(snippetPath),
    script: buildApplyScript({
      snippet,
      snippetPath,
      configRoot,
      serverName: serverNameOf(config.publicURL),
      sudo: config.ssh?.sudo || "auto",
    }),
  };
}

export function createApi({
  getConfig,
  saveConfig,
  paths,
  runtime,
  relay,
  checks,
  log,
  version = "0.1.0",
  invites,
  nginx,
  usageBase = "",
  usageProbe = getJSON,
}) {
  async function save(next) {
    await saveConfig(next);
    return next;
  }

  const routes = {
    "GET /api/state": async () => {
      const config = getConfig();
      return {
        status: 200,
        body: {
          ...maskedState(config, runtime, relay),
          version,
          ...(await sshFields(paths, config.ssh)),
        },
      };
    },

    "POST /api/config": async ({ body }) => {
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { status: 400, body: { error: "config must be a JSON object" } };
      }
      const current = getConfig();
      const merged = { ...current, ...pick(body, CONFIG_FIELDS) };
      if (body.ssh !== undefined) {
        if (body.ssh === null || typeof body.ssh !== "object" || Array.isArray(body.ssh)) {
          return { status: 400, body: { error: "ssh must be an object" } };
        }
        merged.ssh = { ...current.ssh, ...pick(body.ssh, SSH_FIELDS) };
      }
      if (body.nginx !== undefined) {
        if (body.nginx === null || typeof body.nginx !== "object" || Array.isArray(body.nginx)) {
          return { status: 400, body: { error: "nginx must be an object" } };
        }
        merged.nginx = { ...current.nginx, ...pick(body.nginx, NGINX_FIELDS) };
      }
      let next;
      try {
        next = normalizeConfig(merged);
      } catch (err) {
        return { status: 400, body: { error: String(err?.message || err) } };
      }
      await save(next);
      return {
        status: 200,
        body: { ...maskedState(next, runtime, relay), version },
      };
    },

    "POST /api/relay/start": async () => {
      const pre = await checks.preflight();
      if (!pre.ok) {
        const fatal = firstFatal(pre.checks);
        return {
          status: 409,
          body: {
            error: "preflight_failed",
            detail: fatal?.detail || "preflight failed",
            checks: pre.checks,
          },
        };
      }
      const current = getConfig();
      const next = normalizeConfig({ ...current, enabled: true });
      await save(next);
      const started = await relay.start();
      if (started && started.ok === false) {
        return {
          status: 409,
          body: {
            error: "relay_start_failed",
            detail: started.detail || "the relay did not start",
            checks: started.checks || [],
          },
        };
      }
      return { status: 200, body: { ok: true, relay: relay.status?.() ?? null } };
    },

    "POST /api/relay/stop": async ({ body }) => {
      if (body?.confirm !== true) {
        return { status: 400, body: { error: "confirm_required" } };
      }
      const current = getConfig();
      const next = normalizeConfig({ ...current, enabled: false });
      await save(next);
      await relay.stop();
      return { status: 200, body: { ok: true, relay: relay.status?.() ?? null } };
    },

    "GET /api/diagnose": async () => {
      const [pre, pub] = await Promise.all([checks.preflight(), checks.public()]);
      return {
        status: 200,
        body: {
          ok: Boolean(pre.ok && pub.ok),
          fatal: Boolean(pre.fatal || pub.fatal),
          preflight: pre,
          public: pub,
        },
      };
    },

    "GET /api/logs": async ({ query = {} }) => {
      const requested = Number.parseInt(query.n, 10);
      const n = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 1000) : 200;
      return { status: 200, body: { entries: log.tail(n) } };
    },

    "POST /api/nginx/preview": async () => {
      const config = getConfig();
      try {
        const preview = nginx?.preview ? nginx.preview(config) : defaultPreview(config);
        return { status: 200, body: preview };
      } catch (err) {
        return { status: 400, body: { error: String(err?.message || err) } };
      }
    },

    "POST /api/nginx/apply": async ({ body }) => {
      if (body?.confirm !== true) {
        return { status: 400, body: { error: "confirm_required" } };
      }
      if (!nginx?.apply) return { status: 501, body: { error: "nginx apply is not available" } };
      const config = getConfig();
      let result;
      try {
        result = await nginx.apply(config);
      } catch (err) {
        return { status: 502, body: { error: "nginx_apply_failed", detail: String(err?.message || err) } };
      }
      if (!result?.ok) {
        return { status: 409, body: { error: "nginx_apply_failed", ...result } };
      }
      const next = normalizeConfig({
        ...config,
        nginx: { ...config.nginx, lastAppliedAt: result.appliedAt || new Date().toISOString() },
      });
      await save(next);
      return { status: 200, body: { ok: true, ...result } };
    },

    "POST /api/invites": async ({ body }) => {
      if (!body || typeof body !== "object" || typeof body.name !== "string" || !body.name.trim()) {
        return { status: 400, body: { error: "name is required" } };
      }
      if (!invites?.create) return { status: 501, body: { error: "invite creation is not available" } };
      let limit;
      try {
        limit = normalizeLimit(body.limit);
      } catch (err) {
        return { status: 400, body: { error: String(err?.message || err) } };
      }
      let created;
      try {
        created = await invites.create({ name: body.name.trim(), limit });
      } catch (err) {
        return { status: 502, body: { error: "invite_create_failed", detail: String(err?.message || err) } };
      }
      const current = getConfig();
      const next = normalizeConfig({
        ...current,
        invites: [...(current.invites || []), created.invite],
      });
      await save(next);
      return {
        status: 200,
        body: { invite: maskInvite(created.invite), warning: created.warning || "" },
      };
    },

    "GET /api/usage": async () => {
      const config = getConfig();
      const active = (config.invites || []).filter((invite) => invite && !invite.revoked && invite.secret);
      let base = typeof usageBase === "function" ? usageBase() : usageBase;
      if (!base) {
        try {
          base = buildLinks(config.publicURL).base;
        } catch {
          base = "";
        }
      }
      const entries = await Promise.all(active.map(async (invite) => {
        if (!base) {
          return { id: invite.id, name: invite.name, error: "no gateway address" };
        }
        let answer;
        try {
          answer = await usageProbe(`${base}/v1/magpie/limit`, {
            headers: { Authorization: `Bearer ${invite.secret}` },
            timeoutMs: 5000,
          });
        } catch (err) {
          answer = { status: 0, json: null, error: String(err?.message || err) };
        }
        const json = answer?.json || {};
        return {
          id: invite.id,
          name: invite.name,
          limited: json.limited ?? null,
          period: json.period ?? "",
          reset: json.reset ?? "",
          tokensLeft: json.tokensLeft ?? null,
          costLeft: json.costLeft ?? null,
          error: answer?.status === 200 ? "" : (answer?.error || `HTTP ${answer?.status || "no answer"}`),
        };
      }));
      return { status: 200, body: { entries } };
    },
  };

  function findInvite(id) {
    const config = getConfig();
    return { config, invite: (config.invites || []).find((entry) => entry?.id === id) || null };
  }

  const inviteRoutes = {
    reveal: async ({ id }) => {
      const { config, invite } = findInvite(id);
      if (!invite) return { status: 404, body: { error: "invite not found" } };
      const secret = invites?.reveal ? invites.reveal(config, id) : invite.secret;
      if (!secret) return { status: 410, body: { error: "this invite has no secret" } };
      return { status: 200, body: { secret } };
    },

    rotate: async ({ id }) => {
      const { config, invite } = findInvite(id);
      if (!invite) return { status: 404, body: { error: "invite not found" } };
      const result = await invites.rotate({ invite });
      const updated = result.invite || result;
      await save(replaceInvite(config, updated));
      return { status: 200, body: { invite: maskInvite(updated) } };
    },

    revoke: async ({ id, body }) => {
      if (body?.confirm !== true) {
        return { status: 400, body: { error: "confirm_required" } };
      }
      const { config, invite } = findInvite(id);
      if (!invite) return { status: 404, body: { error: "invite not found" } };
      const result = await invites.revoke({ invite, confirm: true });
      const updated = result.invite || result;
      await save(replaceInvite(config, updated));
      return { status: 200, body: { invite: maskInvite(updated) } };
    },

    limit: async ({ id, body }) => {
      const { config, invite } = findInvite(id);
      if (!invite) return { status: 404, body: { error: "invite not found" } };
      let limit;
      try {
        limit = normalizeLimit(body);
      } catch (err) {
        return { status: 400, body: { error: String(err?.message || err) } };
      }
      const result = await invites.updateLimit({ invite, limit });
      const updated = result.invite || result;
      await save(replaceInvite(config, updated));
      return { status: 200, body: { invite: maskInvite(updated) } };
    },
  };

  return async function handle(request = {}) {
    const method = String(request.method || "GET").toUpperCase();
    const path = String(request.path || "/");

    const inviteMatch = /^\/api\/invites\/([^/]+)\/(reveal|rotate|revoke|limit)$/.exec(path);
    if (inviteMatch) {
      if (method !== "POST") return { status: 405, body: { error: "method not allowed" } };
      const [, id, action] = inviteMatch;
      return inviteRoutes[action]({ ...request, id });
    }

    const route = routes[`${method} ${path}`];
    if (!route) {
      const known = Object.keys(routes).some((key) => key.endsWith(` ${path}`));
      return known
        ? { status: 405, body: { error: "method not allowed" } }
        : { status: 404, body: { error: "not found" } };
    }
    return route(request);
  };
}
