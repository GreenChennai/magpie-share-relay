import { test, expect } from "bun:test";
import { createApi } from "../lib/api.mjs";

test("preview never writes and apply needs an explicit confirm", async () => {
  let applied = 0;
  const config = {
    publicURL: "https://us.cyanai.eu.cc/magpie",
    remotePort: 13425,
    nginx: {},
  };
  const api = createApi({
    getConfig: () => config,
    saveConfig: async () => {},
    paths: { configDir: "/tmp" }, runtime: {}, relay: { status: () => ({ state: "off" }) },
    checks: {}, log: { tail: () => [] }, version: "0.1.0",
    nginx: {
      preview: () => ({ snippet: "location /magpie/ { }", include: "include ...;" }),
      apply: async () => { applied++; return { ok: true, code: "ok" }; },
    },
  });
  const p = await api({ method: "POST", path: "/api/nginx/preview" });
  expect(p.status).toBe(200);
  expect(p.body.snippet).toBe("location /magpie/ { }");
  expect(applied).toBe(0);

  const refused = await api({ method: "POST", path: "/api/nginx/apply" });
  expect(refused.status).toBe(400);

  const a = await api({ method: "POST", path: "/api/nginx/apply", body: { confirm: true } });
  expect(a.status).toBe(200);
  expect(applied).toBe(1);
});

test("a failed apply is reported as nginx_apply_failed", async () => {
  const api = createApi({
    getConfig: () => ({ publicURL: "https://us.cyanai.eu.cc/magpie", remotePort: 13425, nginx: {} }),
    saveConfig: async () => {},
    paths: { configDir: "/tmp" }, runtime: {}, relay: { status: () => ({ state: "off" }) },
    checks: {}, log: { tail: () => [] }, version: "0.1.0",
    nginx: { preview: () => ({}), apply: async () => ({ ok: false, code: "conflict", detail: "line 1" }) },
  });
  const r = await api({ method: "POST", path: "/api/nginx/apply", body: { confirm: true } });
  expect(r.status).toBe(409);
  expect(r.body.error).toBe("nginx_apply_failed");
  expect(r.body.code).toBe("conflict");
});
