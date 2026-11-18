import { test, expect } from "bun:test";
import { join } from "node:path";
import { createServiceServer } from "../lib/http.mjs";
import { request } from "./helpers/http.mjs";

const uiRoot = join(import.meta.dir, "..", "ui");
const token = "test-token";

async function start() {
  const s = createServiceServer({
    port: 0,
    uiRoot,
    token,
    handle: async ({ path }) =>
      path === "/api/state" ? { status: 200, body: { ok: true } } : { status: 404, body: { error: "not found" } },
  });
  const port = await s.listen();
  return { s, port };
}

test("the HTML carries the token and no CORS header", async () => {
  const { s, port } = await start();
  const r = await request(port, "/");
  expect(r.status).toBe(200);
  expect(r.body).toContain('name="magpie-share-token" content="test-token"');
  expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  await s.close();
});

test("Origin: null and the token pass, a missing token does not", async () => {
  const { s, port } = await start();
  const no = await request(port, "/api/state", { headers: { origin: "null" } });
  expect(no.status).toBe(403);
  const ok = await request(port, "/api/state", { headers: { origin: "null", "x-magpie-share-token": token } });
  expect(ok.status).toBe(200);
  expect(ok.headers["access-control-allow-origin"]).toBe("null");
  const pre = await request(port, "/api/state", { method: "OPTIONS", headers: { origin: "null" } });
  expect(pre.status).toBe(204);
  expect(pre.headers["access-control-allow-headers"]).toContain("x-magpie-share-token");
  await s.close();
});

test("a foreign Host is refused", async () => {
  const { s, port } = await start();
  const r = await request(port, "/api/state", { headers: { host: "evil.example:" + port, origin: "null", "x-magpie-share-token": token } });
  expect(r.status).toBe(403);
  await s.close();
});
