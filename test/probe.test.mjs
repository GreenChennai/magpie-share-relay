import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { getJSON } from "../lib/probe.mjs";

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

test("getJSON reads a JSON body and the status", async () => {
  const { server, port } = await listen((req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end('{"error":"no key"}');
  });
  const r = await getJSON(`http://127.0.0.1:${port}/api/hello`);
  expect(r.status).toBe(401);
  expect(r.json).toEqual({ error: "no key" });
  expect(r.error).toBe("");
  await close(server);
});

test("getJSON times out without a reply", async () => {
  const { server, port } = await listen(() => {});
  const r = await getJSON(`http://127.0.0.1:${port}/`, { timeoutMs: 100 });
  expect(r.status).toBe(0);
  expect(r.error).toBeTruthy();
  await close(server);
});
