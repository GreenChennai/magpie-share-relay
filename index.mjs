import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServiceServer } from "./lib/http.mjs";
import { configPaths, loadConfig, normalizeConfig, saveConfig as persistConfig } from "./lib/config.mjs";
import { createApi } from "./lib/api.mjs";
import { configuredPort, startupDelay } from "./lib/ports.mjs";
import { acquireLock, releaseLock } from "./lib/lock.mjs";
import { createLog } from "./lib/log.mjs";
import { createRelay } from "./lib/relay.mjs";
import { getJSON } from "./lib/probe.mjs";
import { selectLanIP } from "./lib/lanip.mjs";
import { isRetryableFailure, publicHealth, readGatewayPort, runPreflight, runPublicChecks } from "./lib/checks.mjs";
import { buildTunnelArgs, classifyStderr, ensureKey, findBinary, fingerprintOf, runRemote } from "./lib/ssh.mjs";
import { createInvite, revokeInvite, rotateInvite, updateInviteLimit } from "./lib/invites.mjs";
import { createMagpie, findMagpie } from "./lib/magpie.mjs";
import { applyNginx } from "./lib/nginx.mjs";

const PACKAGE_NAME = "magpie-share-relay";
const AUTO_RETRY_MS = 15000;
const VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
const uiRoot = fileURLToPath(new URL("./ui", import.meta.url));
const packageRoot = fileURLToPath(new URL(".", import.meta.url));

let started = null;
let starting = null;
let runtime = null;

function activeKey(config) {
  const invite = (config.invites || []).find((entry) => entry && !entry.revoked && entry.secret);
  return invite?.secret || "";
}

function checkProbe({ url, key, headers }) {
  const sent = headers && Object.keys(headers).length
    ? headers
    : key
      ? { "x-api-key": key }
      : {};
  return getJSON(url, { headers: sent, timeoutMs: 5000 });
}

async function resolveLan(state) {
  const gatewayPort = Number(state.config.gatewayPort) || readGatewayPort(state.paths.configDir);
  const selection = await selectLanIP({
    port: gatewayPort,
    probe: (ip, port) => getJSON(`http://${ip}:${port}/api/hello`, { timeoutMs: 2000 }),
    fixed: state.config.lanIP || "",
  });
  return { selection, lanIP: selection.ip, gatewayPort };
}

async function preflight(state) {
  const { selection, lanIP, gatewayPort } = await resolveLan(state);
  const result = await runPreflight({
    config: state.config,
    paths: state.paths,
    lanIP,
    probe: checkProbe,
    invites: state.config.invites,
    fingerprintOf,
  });
  return { ...result, lanIP, gatewayPort, selection };
}

async function prepareTunnel(state) {
  const checked = await preflight(state);
  if (!checked.ok) {
    const fatal = checked.checks.find((check) => check.fatal && !check.ok);
    return {
      ok: false,
      fatal: checked.fatal,
      retryable: isRetryableFailure(checked.checks),
      checks: checked.checks,
      detail: fatal?.detail || "preflight failed",
      lanIP: checked.lanIP,
      gatewayPort: checked.gatewayPort,
    };
  }

  const ssh = state.config.ssh || {};
  if (!ssh.host || !ssh.user) {
    const checks = [
      ...checked.checks,
      { id: "ssh", ok: false, fatal: true, detail: "SSH host and user are required" },
    ];
    return { ok: false, fatal: true, retryable: false, checks, detail: "SSH host and user are required" };
  }

  const keyPath = ssh.keyPath || state.paths.keyPath;
  try {
    await ensureKey({ keyPath });
  } catch (err) {
    const detail = String(err?.message || err);
    const checks = [...checked.checks, { id: "ssh-key", ok: false, fatal: true, detail }];
    return { ok: false, fatal: true, retryable: false, checks, detail };
  }

  const args = buildTunnelArgs({
    ssh: { ...ssh, bin: ssh.bin || findBinary("ssh") },
    remotePort: state.config.remotePort,
    lanIP: checked.lanIP,
    gatewayPort: checked.gatewayPort,
    keyPath,
    knownHostsPath: state.paths.knownHostsPath,
  });
  return {
    ok: true,
    fatal: false,
    retryable: false,
    checks: checked.checks,
    args,
    lanIP: checked.lanIP,
    gatewayPort: checked.gatewayPort,
  };
}

async function prepareForRelay(state) {
  if (state.cachedArgs && Date.now() - state.lastPreparedAt < 5000) return state.cachedArgs;
  const prepared = await prepareTunnel(state);
  if (!prepared.ok) {
    state.preflight = prepared;
    const err = new Error(prepared.detail);
    // A LAN failure is worth retrying; a security failure is not.
    err.fatal = !prepared.retryable;
    throw err;
  }
  state.cachedArgs = prepared.args;
  state.lastPreparedAt = Date.now();
  state.lanIP = prepared.lanIP;
  state.gatewayPort = prepared.gatewayPort;
  state.preflight = { ok: true, fatal: false, checks: prepared.checks, at: Date.now() };
  return prepared.args;
}

async function checkPublic(state) {
  const result = await runPublicChecks({
    publicURL: state.config.publicURL,
    key: activeKey(state.config),
    probe: checkProbe,
  });
  const health = publicHealth(result.checks);
  state.lastPublicCheck = { ok: health.ok, fatal: health.fatal, keyOk: health.keyOk };
  state.lastPublicCheckAt = Date.now();
  return { result, health };
}

function publicProbe(state) {
  return async () => {
    const { health } = await checkPublic(state);
    return { ok: health.ok, fatal: health.fatal, detail: health.detail };
  };
}

function createRuntimeRelay(state) {
  return createRelay({
    args: [],
    prepare: () => prepareForRelay(state),
    spawn: (argv) => spawn(argv[0], argv.slice(1), {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    }),
    log: state.log,
    probe: publicProbe(state),
    classify: classifyStderr,
  });
}

export async function startRelay() {
  const state = runtime;
  if (!state) return { ok: false, fatal: true, retryable: false, checks: [], detail: "plugin is not ready" };

  const current = state.relay.status().state;
  if (current === "up" || current === "starting") {
    return { ok: true, fatal: false, checks: [], lanIP: state.lanIP, gatewayPort: state.gatewayPort };
  }

  if (!state.hasLock) {
    if (!acquireLock({ lockPath: state.paths.lockPath, pid: process.pid })) {
      const checks = [{
        id: "lock",
        ok: false,
        fatal: true,
        detail: "another magpie instance is running the relay",
      }];
      return { ok: false, fatal: true, retryable: false, checks, detail: checks[0].detail };
    }
    state.hasLock = true;
  }

  const prepared = await prepareTunnel(state);
  if (!prepared.ok) {
    state.preflight = prepared;
    state.relay.markPreflightFailed(prepared.detail);
    return prepared;
  }

  state.cachedArgs = prepared.args;
  state.lastPreparedAt = Date.now();
  state.lanIP = prepared.lanIP;
  state.gatewayPort = prepared.gatewayPort;
  state.preflight = { ok: true, fatal: false, checks: prepared.checks, at: Date.now() };
  state.log.event("relay", "starting", { lanIP: prepared.lanIP, gatewayPort: prepared.gatewayPort });
  await state.relay.start();
  return {
    ok: true,
    fatal: false,
    checks: prepared.checks,
    lanIP: prepared.lanIP,
    gatewayPort: prepared.gatewayPort,
  };
}

export async function stopRelay() {
  const state = runtime;
  if (!state) return;
  state.cachedArgs = null;
  state.lastPreparedAt = 0;
  state.log.event("relay", "stopping");
  await state.relay.stop();
}

async function autoStart(state, retried = false) {
  if (!state.config.enabled || !state.config.autoStart || !state.hasLock) return;
  let result;
  try {
    result = await startRelay();
  } catch (err) {
    result = { ok: false, fatal: true, retryable: false, checks: [], detail: String(err?.message || err) };
  }
  if (result.ok) return;
  if (retried || !result.retryable) {
    state.relay.markPreflightFailed(result.detail || "preflight failed");
    return;
  }
  setTimeout(() => {
    if (runtime !== state || !state.hasLock) return;
    autoStart(state, true).catch(() => {});
  }, AUTO_RETRY_MS).unref?.();
}

function takeLock(state, onAcquired) {
  const lockPath = state.paths.lockPath;
  const attempt = () => {
    if (acquireLock({ lockPath, pid: process.pid })) {
      state.hasLock = true;
      return true;
    }
    return false;
  };
  if (attempt()) {
    onAcquired?.();
    return;
  }
  const timer = setInterval(() => {
    if (attempt()) {
      clearInterval(timer);
      onAcquired?.();
    }
  }, 10000);
  timer.unref?.();
}

export default {
  id: PACKAGE_NAME,

  async server(input, options) {
    if (started) return {};
    if (!starting) {
      starting = (async () => {
        const paths = configPaths();
        const config = await loadConfig(paths);
        const configured = configuredPort({
          pluginsPath: join(paths.configDir, "plugins.json"),
          packageName: PACKAGE_NAME,
          packageRoot,
        });
        const optionsPort = Number(options?.port) || 3488;
        let api = null;
        const service = createServiceServer({
          port: optionsPort,
          uiRoot,
          handle: async (request) => {
            if (!api) return { status: 503, body: { error: "the plugin is still starting" } };
            return api(request);
          },
        });
        let actualPort;
        try {
          actualPort = await service.listen();
        } catch (err) {
          if (err?.code === "EADDRINUSE") {
            throw new Error(`share-relay: port ${optionsPort} is in use; change the plugin's port in Settings → Plugins`);
          }
          throw err;
        }

        const log = createLog({
          path: paths.logPath,
          secrets: () => (runtime?.config?.invites || []).map((invite) => invite.secret).filter(Boolean),
        });
        if (config.recoveredFromBackup) {
          log.event("config", "config.json was invalid; the backup is in use", { path: paths.configPath });
        }
        runtime = {
          paths,
          config,
          configRecovered: Boolean(config.recoveredFromBackup),
          port: actualPort,
          configuredPort: configured,
          isPrimary: optionsPort === configured,
          hasLock: false,
          service,
          log,
          relay: null,
          preflight: null,
          lanIP: config.lanIP || "",
          gatewayPort: 0,
          cachedArgs: null,
          lastPreparedAt: 0,
          checks: null,
          lastPublicCheck: null,
          lastPublicCheckAt: 0,
        };
        runtime.relay = createRuntimeRelay(runtime);
        runtime.checks = {
          preflight: () => preflight(runtime),
          public: () => checkPublic(runtime).then(({ result }) => result),
        };
        const saveAndApply = async (next) => {
          await persistConfig(paths, next);
          runtime.config = normalizeConfig(next);
          runtime.cachedArgs = null;
          runtime.lastPreparedAt = 0;
          runtime.magpie = null;
        };
        const magpieClient = async () => {
          if (runtime.magpie) return runtime.magpie;
          const bin = await findMagpie({ configured: runtime.config.magpieBin });
          runtime.magpie = createMagpie({ bin });
          return runtime.magpie;
        };
        const localGatewayBase = async () => {
          if (!runtime.lanIP) {
            const resolved = await resolveLan(runtime);
            runtime.lanIP = resolved.lanIP;
            runtime.gatewayPort = resolved.gatewayPort;
          }
          if (!runtime.lanIP) return "";
          return `http://${runtime.lanIP}:${runtime.gatewayPort || readGatewayPort(paths.configDir)}`;
        };
        const invitesAdapter = {
          create: async ({ name, limit }) => {
            const magpie = await magpieClient();
            const base = await localGatewayBase();
            return createInvite({
              name,
              limit,
              magpie,
              verifyHeld: base
                ? (secret) => getJSON(`${base}/v1/magpie/usage`, {
                  headers: { "x-api-key": secret },
                  timeoutMs: 5000,
                })
                : undefined,
            });
          },
          reveal: (config, id) => (config.invites || []).find((invite) => invite.id === id)?.secret || "",
          revoke: async ({ invite }) => revokeInvite({ invite, magpie: await magpieClient() }),
          rotate: async ({ invite }) => rotateInvite({ invite, magpie: await magpieClient() }),
          updateLimit: async ({ invite, limit }) => updateInviteLimit({
            invite,
            limit,
            magpie: await magpieClient(),
          }),
        };
        const nginxAdapter = {
          apply: async (config) => {
            const keyPath = config.ssh?.keyPath || paths.keyPath;
            await ensureKey({ keyPath });
            return applyNginx({
              config,
              log,
              runRemote: (script, timeoutMs) => runRemote({
                ssh: { ...config.ssh, bin: config.ssh?.bin || findBinary("ssh") },
                keyPath,
                knownHostsPath: paths.knownHostsPath,
                script,
                timeoutMs,
              }),
            });
          },
        };
        api = createApi({
          getConfig: () => runtime.config,
          saveConfig: saveAndApply,
          paths,
          runtime,
          relay: {
            start: () => startRelay(),
            stop: () => stopRelay(),
            status: () => runtime.relay.status(),
          },
          checks: runtime.checks,
          log,
          version: VERSION,
          invites: invitesAdapter,
          nginx: nginxAdapter,
          usageBase: () => (runtime.lanIP
            ? `http://${runtime.lanIP}:${runtime.gatewayPort || readGatewayPort(paths.configDir)}`
            : ""),
        });
        started = service;
        process.once("exit", () => {
          runtime?.relay?.stop?.();
          releaseLock({ lockPath: paths.lockPath, pid: process.pid });
        });
        const onLock = () => {
          autoStart(runtime).catch(() => {});
        };
        const delay = startupDelay(optionsPort, configured);
        if (delay > 0) setTimeout(() => takeLock(runtime, onLock), delay).unref?.();
        else takeLock(runtime, onLock);
      })();
      starting.catch(() => {
        starting = null;
      });
    }
    await starting;
    return {};
  },
};
