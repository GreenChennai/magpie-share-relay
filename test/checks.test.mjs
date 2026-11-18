import { test, expect } from "bun:test";
import { isRetryableFailure, publicHealth, runPreflight, runPublicChecks } from "../lib/checks.mjs";

const config = {
  publicURL: "https://us.cyanai.eu.cc/magpie",
  ssh: { host: "us.cyanai.eu.cc", port: 22, user: "root", fingerprint: "" },
  invites: [{ id: "fr_1", name: "Alice", secret: "test-secret-1234", revoked: false }],
};

test("a 200 without a key is fatal, a 403 with a key is not", async () => {
  const probe = async ({ url, key }) => {
    if (!key) return { status: 200, json: { name: "magpie" } };
    if (url.endsWith("/v1/magpie/usage")) return { status: 200, json: {} };
    return { status: 200, json: { name: "magpie" } };
  };
  const r = await runPreflight({
    config, paths: { configDir: "/tmp" }, lanIP: "192.168.66.6", probe,
    invites: config.invites,
  });
  expect(r.ok).toBe(false);
  expect(r.fatal).toBe(true);
  expect(r.checks.find((c) => c.id === "no-key").ok).toBe(false);
  expect(r.checks.find((c) => c.id === "held").ok).toBe(false);
});

test("public admin 200 is fatal, missing key is not", async () => {
  const probe = async ({ url, key }) => {
    if (url.includes("/v1/magpie/admin/")) return { status: 200, json: {} };
    if (!key) return { status: 401, json: { error: "key" } };
    return { status: 200, json: { name: "magpie" } };
  };
  const r = await runPublicChecks({ publicURL: config.publicURL, key: config.invites[0].secret, probe });
  expect(r.fatal).toBe(true);
  expect(r.checks.find((c) => c.id === "public-admin").ok).toBe(false);
});

test("a rejected invite key does not make the tunnel unhealthy", () => {
  const r = publicHealth([
    { id: "public-no-key", ok: true, fatal: false },
    { id: "public-key", ok: false, fatal: false, detail: "the invite key was refused" },
    { id: "public-admin", ok: true, fatal: false },
  ]);
  expect(r.ok).toBe(true);
  expect(r.keyOk).toBe(false);
});

test("a public URL that answers without a key is unhealthy", () => {
  const r = publicHealth([
    { id: "public-no-key", ok: false, fatal: true, detail: "the public URL answers without a key" },
  ]);
  expect(r.ok).toBe(false);
  expect(r.fatal).toBe(true);
});

test("a LAN failure is retryable, a security failure is not", () => {
  expect(isRetryableFailure([{ id: "lan", ok: false, fatal: true }])).toBe(true);
  expect(isRetryableFailure([{ id: "no-key", ok: false, fatal: true }])).toBe(false);
  expect(isRetryableFailure([{ id: "share", ok: false, fatal: true }])).toBe(false);
  expect(isRetryableFailure([{ id: "host-key", ok: false, fatal: true }])).toBe(false);
});
