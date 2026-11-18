import { test, expect } from "bun:test";
import { createApi } from "../lib/api.mjs";

function fixture() {
  let config = {
    enabled: false, autoStart: true, publicURL: "https://us.cyanai.eu.cc/magpie",
    invites: [{ id: "fr_1", name: "Alice", secret: "test-secret-1234", secretMasked: "****1234", revoked: false }],
    ssh: {}, nginx: {},
  };
  const calls = [];
  const relay = {
    start: () => calls.push(["start"]),
    stop: () => calls.push(["stop"]),
    status: () => ({ state: "off" }),
  };
  const checks = {
    preflight: async () => ({ ok: false, fatal: true, checks: [{ id: "no-key", ok: false }] }),
    public: async () => ({ ok: true, fatal: false, checks: [] }),
  };
  const runtime = { primary: true, hasLock: true, servicePort: 3488, configuredPort: 3488 };
  const api = createApi({
    getConfig: () => config,
    saveConfig: async (c) => { config = c; calls.push(["save", c.enabled]); },
    paths: { configDir: "/tmp" },
    runtime,
    relay,
    checks,
    log: { tail: () => [] },
    version: "0.1.0",
  });
  return { api, calls, relay, checks, runtime, getConfig: () => config };
}

test("state masks every secret", async () => {
  const { api } = fixture();
  const r = await api({ method: "GET", path: "/api/state" });
  expect(r.status).toBe(200);
  expect(JSON.stringify(r.body)).not.toContain("test-secret-1234");
  expect(r.body.invites[0].secretMasked).toBe("****1234");
});

test("state carries the last public check and when it ran", async () => {
  const { api, runtime } = fixture();
  runtime.lastPublicCheck = { ok: true, fatal: false };
  runtime.lastPublicCheckAt = 1763452800000;
  const r = await api({ method: "GET", path: "/api/state" });
  expect(r.status).toBe(200);
  expect(r.body.publicCheck).toEqual({ ok: true, fatal: false });
  expect(r.body.publicCheckAt).toBe(1763452800000);
});

test("start refuses when preflight says no", async () => {
  const { api, calls } = fixture();
  const r = await api({ method: "POST", path: "/api/relay/start" });
  expect(r.status).toBe(409);
  expect(calls.some((c) => c[0] === "start")).toBe(false);
});

test("config saves only whitelisted fields and ignores invites and port", async () => {
  const { api, calls, getConfig } = fixture();
  const r = await api({
    method: "POST",
    path: "/api/config",
    body: {
      autoStart: false,
      publicURL: "https://us.cyanai.eu.cc/share",
      remotePort: 13426,
      lanIP: "192.168.66.6",
      port: 9999,
      invites: [{ id: "evil", secret: "leak" }],
      ssh: { user: "deploy", host: "rn.example" },
      nginx: { configRoot: "/etc/nginx", lastAppliedAt: "hacked" },
    },
  });
  expect(r.status).toBe(200);
  expect(r.body.publicURL).toBe("https://us.cyanai.eu.cc/share");
  expect(r.body.remotePort).toBe(13426);
  expect(r.body.autoStart).toBe(false);
  expect(r.body.ssh.user).toBe("deploy");
  expect(calls.some((c) => c[0] === "save")).toBe(true);
  const saved = getConfig();
  expect(saved.invites[0].id).toBe("fr_1");
  expect(saved.invites[0].secret).toBe("test-secret-1234");
});

test("start saves enabled=true and asks the relay to start after a good preflight", async () => {
  const { api, calls, relay, checks, getConfig } = fixture();
  checks.preflight = async () => ({ ok: true, fatal: false, checks: [] });
  relay.status = () => ({ state: "starting" });

  const r = await api({ method: "POST", path: "/api/relay/start" });
  expect(r.status).toBe(200);
  expect(calls.some((c) => c[0] === "save" && c[1] === true)).toBe(true);
  expect(calls.some((c) => c[0] === "start")).toBe(true);
  expect(getConfig().enabled).toBe(true);

  const stop = await api({ method: "POST", path: "/api/relay/stop", body: { confirm: true } });
  expect(stop.status).toBe(200);
  expect(calls.some((c) => c[0] === "save" && c[1] === false)).toBe(true);
  expect(calls.some((c) => c[0] === "stop")).toBe(true);
});

test("diagnose merges both check sets and unknown routes are 404", async () => {
  const { api } = fixture();
  const d = await api({ method: "GET", path: "/api/diagnose" });
  expect(d.status).toBe(200);
  expect(d.body.preflight.ok).toBe(false);
  expect(d.body.public.ok).toBe(true);

  const unknown = await api({ method: "GET", path: "/api/nope" });
  expect(unknown.status).toBe(404);
});
