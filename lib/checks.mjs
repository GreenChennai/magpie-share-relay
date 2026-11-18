import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fingerprintOf as realFingerprintOf } from "./ssh.mjs";

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function readShareSettings(configDir) {
  const settings = readJSON(join(configDir, "settings.json")) || {};
  return {
    lan: settings.lan === true,
    https: settings.https === true,
    mtls: settings.mtls === true,
  };
}

export function readGatewayPort(configDir) {
  const gateway = readJSON(join(configDir, "gateway.json")) || {};
  const match = /:(\d+)\s*$/.exec(String(gateway.addr || ""));
  const port = match ? Number(match[1]) : 0;
  return port >= 1 && port <= 65535 ? port : 3425;
}

async function ask(probe, url, key, headers = {}) {
  try {
    const answer = await probe({ url, key, headers });
    return answer || { status: 0 };
  } catch (err) {
    return { status: 0, error: String(err?.message || err) };
  }
}

function summarize(checks) {
  const fatal = checks.some((check) => check.fatal && !check.ok);
  return { ok: !fatal, fatal, checks };
}

export function isRetryableFailure(checks = []) {
  const security = new Set(["share", "plaintext", "host-key", "no-key"]);
  return !checks.some((check) => check.fatal && !check.ok && security.has(check.id));
}

// A rejected invite key means one friend cannot use the share; it does not
// mean the tunnel is down. Only the no-key and fatal checks decide health.
export function publicHealth(checks = []) {
  const fatal = checks.find((check) => check.fatal && !check.ok) || null;
  const noKey = checks.find((check) => check.id === "public-no-key");
  const keyed = checks.find((check) => check.id === "public-key");
  return {
    ok: !fatal && Boolean(noKey?.ok),
    fatal: Boolean(fatal),
    keyOk: keyed ? Boolean(keyed.ok) : true,
    detail: fatal?.detail
      || (noKey?.ok
        ? (keyed && !keyed.ok ? keyed.detail : "")
        : noKey?.detail || "public URL is not reachable"),
  };
}

function activeInvites(invites) {
  return (Array.isArray(invites) ? invites : []).filter(
    (invite) => invite && !invite.revoked && typeof invite.secret === "string" && invite.secret,
  );
}

export async function runPreflight({
  config,
  paths,
  lanIP,
  probe,
  invites,
  fingerprintOf = realFingerprintOf,
}) {
  const settings = readShareSettings(paths.configDir);
  const gatewayPort = Number(config.gatewayPort) || readGatewayPort(paths.configDir);
  const active = activeInvites(invites ?? config.invites);
  const checks = [];

  checks.push({
    id: "share",
    ok: settings.lan,
    fatal: true,
    detail: settings.lan
      ? "magpie's LAN sharing is on"
      : "magpie's LAN sharing is off (Settings → Network and sharing)",
  });

  const plaintext = !settings.https && !settings.mtls;
  checks.push({
    id: "plaintext",
    ok: plaintext,
    fatal: true,
    detail: plaintext
      ? "the gateway serves plain HTTP on the LAN; RN terminates TLS"
      : "the gateway has HTTPS or mTLS on; the tunnel target must be plain HTTP on the LAN",
  });

  let hostKey = {
    id: "host-key",
    ok: true,
    fatal: true,
    detail: "no host fingerprint configured; the first connection records it",
  };
  if (config.ssh?.fingerprint) {
    const actual = paths.knownHostsPath
      ? await fingerprintOf({ knownHostsPath: paths.knownHostsPath })
      : "";
    if (!actual) {
      hostKey = { ...hostKey, detail: "known_hosts has no fingerprint yet" };
    } else {
      const matches = actual === config.ssh.fingerprint;
      hostKey = {
        id: "host-key",
        ok: matches,
        fatal: true,
        detail: matches
          ? "the recorded host key matches"
          : `known_hosts says ${actual}, config says ${config.ssh.fingerprint}`,
      };
    }
  }
  checks.push(hostKey);

  if (!lanIP) {
    checks.push({ id: "lan", ok: false, fatal: true, detail: "no LAN IP was found" });
    checks.push({ id: "no-key", ok: false, fatal: false, detail: "not checked: no LAN IP" });
    checks.push({ id: "key", ok: true, fatal: false, detail: "not checked: no LAN IP" });
    checks.push({ id: "held", ok: true, fatal: false, detail: "not checked: no LAN IP" });
    return summarize(checks);
  }

  const helloURL = `http://${lanIP}:${gatewayPort}/api/hello`;
  const lan = await ask(probe, helloURL);
  checks.push({
    id: "lan",
    ok: (lan.status || 0) > 0,
    fatal: true,
    detail: lan.status ? `gateway answered ${lan.status}` : (lan.error || "gateway did not answer"),
    status: lan.status || 0,
  });

  const noKey = await ask(probe, helloURL);
  let noKeyCheck;
  if (noKey.status === 401) {
    noKeyCheck = { id: "no-key", ok: true, fatal: true, detail: "the gateway asks for a key (401)", status: 401 };
  } else if (noKey.status === 403) {
    noKeyCheck = { id: "no-key", ok: true, fatal: true, detail: "the gateway refuses without a key (403; is LAN sharing on?)", status: 403 };
  } else if (noKey.status === 200) {
    noKeyCheck = { id: "no-key", ok: false, fatal: true, detail: "the gateway answers without a key", status: 200 };
  } else {
    noKeyCheck = { id: "no-key", ok: false, fatal: false, detail: noKey.error || `gateway answered ${noKey.status || "nothing"}`, status: noKey.status || 0 };
  }
  checks.push(noKeyCheck);

  if (!active.length) {
    checks.push({ id: "key", ok: true, fatal: false, detail: "create a friend key to check with one" });
    checks.push({ id: "held", ok: true, fatal: false, detail: "create a friend key to check with one" });
    return summarize(checks);
  }

  const key = active[0].secret;
  const headers = { "x-api-key": key };
  const withKey = await ask(probe, helloURL, key, headers);
  checks.push({
    id: "key",
    ok: withKey.status === 200,
    fatal: false,
    detail: withKey.status === 200
      ? "the invite key is accepted"
      : withKey.status === 401
        ? "the invite key was refused"
        : withKey.error || `gateway answered ${withKey.status || "nothing"}`,
    status: withKey.status || 0,
  });

  const usageURL = `http://${lanIP}:${gatewayPort}/v1/magpie/usage`;
  const held = await ask(probe, usageURL, key, headers);
  checks.push({
    id: "held",
    ok: held.status === 403,
    fatal: false,
    detail: held.status === 403
      ? "the invite key cannot read whole-machine usage"
      : held.status === 200
        ? "the invite key can read whole-machine usage; nginx must block it"
        : held.error || `usage answered ${held.status || "nothing"}`,
    status: held.status || 0,
  });

  return summarize(checks);
}

export async function runPublicChecks({ publicURL, key, probe }) {
  const base = String(publicURL || "").replace(/\/+$/, "");
  if (!base) {
    return summarize([{ id: "public-url", ok: false, fatal: true, detail: "publicURL is empty" }]);
  }

  const checks = [];
  const headers = key ? { "x-api-key": key } : {};

  const noKey = await ask(probe, `${base}/api/hello`);
  checks.push({
    id: "public-no-key",
    ok: noKey.status === 401,
    fatal: noKey.status === 200,
    detail: noKey.status === 401
      ? "the public URL asks for a key (401)"
      : noKey.status === 200
        ? "the public URL answers without a key"
        : noKey.error || `public URL answered ${noKey.status || "nothing"}`,
    status: noKey.status || 0,
  });

  if (key) {
    const withKey = await ask(probe, `${base}/api/hello`, key, headers);
    checks.push({
      id: "public-key",
      ok: withKey.status === 200 && withKey.json?.name === "magpie",
      fatal: false,
      detail: withKey.status !== 200
        ? withKey.error || `public URL answered ${withKey.status || "nothing"} with the key`
        : withKey.json?.name === "magpie"
          ? "the public URL serves magpie with the key"
          : "the public URL answered with the key, but not as magpie",
      status: withKey.status || 0,
    });
  } else {
    checks.push({ id: "public-key", ok: true, fatal: false, detail: "no active invite key to check with" });
  }

  const admin = await ask(probe, `${base}/v1/magpie/admin/`, key, headers);
  checks.push({
    id: "public-admin",
    ok: admin.status !== 200,
    fatal: admin.status === 200,
    detail: admin.status === 200
      ? "the public admin API answers; nginx must block /v1/magpie/admin/"
      : admin.error || `admin API answered ${admin.status || "nothing"}`,
    status: admin.status || 0,
  });

  const usage = await ask(probe, `${base}/v1/magpie/usage`, key, headers);
  checks.push({
    id: "public-usage",
    ok: usage.status === 403,
    fatal: false,
    detail: usage.status === 403
      ? "nginx blocks whole-machine usage (403)"
      : usage.status === 200
        ? "whole-machine usage is reachable; nginx must block /v1/magpie/usage"
        : usage.error || `usage answered ${usage.status || "nothing"}`,
    status: usage.status || 0,
  });

  const tlsError = [noKey, admin, usage].map((answer) => answer?.error || "").find((error) => /CERT|TLS/i.test(error));
  checks.push({
    id: "public-tls",
    ok: !tlsError,
    fatal: Boolean(tlsError),
    detail: tlsError || "no TLS error",
  });

  return summarize(checks);
}
