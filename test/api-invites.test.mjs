import { test, expect } from "bun:test";
import { createApi } from "../lib/api.mjs";

test("create returns a masked invite, reveal is its own POST", async () => {
  let config = { invites: [] };
  const api = createApi({
    getConfig: () => config,
    saveConfig: async (c) => { config = c; },
    paths: { configDir: "/tmp" },
    runtime: {},
    relay: { status: () => ({ state: "off" }) },
    checks: {},
    log: { tail: () => [] },
    version: "0.1.0",
    invites: {
      create: async ({ name }) => ({ invite: { id: "fr_1", name, secret: "test-secret-1234", secretMasked: "****1234", revoked: false }, warning: "" }),
      reveal: (c, id) => c.invites.find((i) => i.id === id)?.secret || "",
      revoke: async ({ invite }) => ({ ...invite, revoked: true, secret: undefined }),
      rotate: async ({ invite }) => ({ invite: { ...invite, secret: "test-secret-5678" }, secret: "test-secret-5678" }),
      updateLimit: async ({ invite }) => invite,
    },
  });
  const made = await api({ method: "POST", path: "/api/invites", body: { name: "Alice" } });
  expect(made.status).toBe(200);
  expect(made.body.invite.secret).toBeUndefined();
  expect(JSON.stringify(made.body)).not.toContain("test-secret-1234");
  const id = made.body.invite.id;
  const shown = await api({ method: "POST", path: `/api/invites/${id}/reveal` });
  expect(shown.body.secret).toBe("test-secret-1234");
  const wrongMethod = await api({ method: "GET", path: `/api/invites/${id}/reveal` });
  expect(wrongMethod.status).toBe(405);
});

test("rotate, revoke and limit save the updated invite and never return its secret", async () => {
  let config = {
    invites: [
      { id: "fr_1", name: "Alice", keyId: "k1", secret: "test-secret-1234", secretMasked: "****1234", revoked: false },
    ],
  };
  const calls = [];
  const api = createApi({
    getConfig: () => config,
    saveConfig: async (c) => { config = c; },
    paths: { configDir: "/tmp" },
    runtime: {},
    relay: { status: () => ({ state: "off" }) },
    checks: {},
    log: { tail: () => [] },
    version: "0.1.0",
    invites: {
      reveal: (c, id) => c.invites.find((i) => i.id === id)?.secret || "",
      rotate: async ({ invite }) => {
        calls.push("rotate");
        return { invite: { ...invite, secret: "test-secret-5678" }, secret: "test-secret-5678" };
      },
      revoke: async ({ invite, confirm }) => {
        calls.push(["revoke", confirm]);
        return { ...invite, revoked: true, secret: undefined };
      },
      updateLimit: async ({ invite, limit }) => {
        calls.push(["limit", limit]);
        return { ...invite, limit };
      },
    },
  });

  const rotated = await api({ method: "POST", path: "/api/invites/fr_1/rotate" });
  expect(rotated.status).toBe(200);
  expect(rotated.body.invite.secret).toBeUndefined();
  expect(JSON.stringify(rotated.body)).not.toContain("test-secret-5678");

  const noConfirm = await api({ method: "POST", path: "/api/invites/fr_1/revoke" });
  expect(noConfirm.status).toBe(400);

  const revoked = await api({ method: "POST", path: "/api/invites/fr_1/revoke", body: { confirm: true } });
  expect(revoked.status).toBe(200);
  expect(revoked.body.invite.revoked).toBe(true);
  expect(calls).toContainEqual(["revoke", true]);

  const limited = await api({
    method: "POST",
    path: "/api/invites/fr_1/limit",
    body: { period: "week", costUsd: 2, tokens: 1000 },
  });
  expect(limited.status).toBe(200);
  expect(limited.body.invite.limit).toEqual({ period: "week", costUsd: 2, tokens: 1000 });
  expect(calls.some((c) => Array.isArray(c) && c[0] === "limit")).toBe(true);
});

test("usage asks every active invite and isolates failures", async () => {
  const config = {
    publicURL: "https://us.cyanai.eu.cc/magpie",
    invites: [
      { id: "fr_1", name: "Alice", secret: "test-secret-1234", revoked: false },
      { id: "fr_2", name: "Bob", secret: "test-secret-9876", revoked: false },
      { id: "fr_3", name: "Gone", secret: "test-secret-1234", revoked: true },
    ],
  };
  const seen = [];
  const api = createApi({
    getConfig: () => config,
    saveConfig: async () => {},
    paths: { configDir: "/tmp" },
    runtime: {},
    relay: { status: () => ({ state: "off" }) },
    checks: {},
    log: { tail: () => [] },
    version: "0.1.0",
    usageBase: "http://192.168.66.6:3425",
    usageProbe: async (url, options) => {
      seen.push([url, options.headers.Authorization]);
      if (options.headers.Authorization.endsWith("9876")) return { status: 0, json: null, error: "timeout" };
      return { status: 200, json: { limited: true, period: "day", reset: "2026-11-19T00:00:00Z", tokensLeft: 10, costLeft: 4.2 } };
    },
  });
  const r = await api({ method: "GET", path: "/api/usage" });
  expect(r.status).toBe(200);
  expect(r.body.entries.length).toBe(2);
  expect(seen.length).toBe(2);
  expect(seen[0][0]).toBe("http://192.168.66.6:3425/v1/magpie/limit");
  expect(r.body.entries[0].limited).toBe(true);
  expect(r.body.entries[1].error).toBe("timeout");
});
