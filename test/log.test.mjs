import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLog, redact } from "../lib/log.mjs";

test("known secrets never reach the log", () => {
  const secret = "test-secret-1234";
  expect(redact(`Authorization: Bearer ${secret}`, [secret])).toBe("Authorization: Bearer ****1234");
  expect(redact("x-api-key: test-secret-9876", [])).toContain("****9876");
  expect(redact("x-api-key: test-secret-9876", [])).not.toContain("test-secret-9876");
});

test("the log sink redacts its own secrets and header objects", () => {
  const dir = mkdtempSync(join(tmpdir(), "share-relay-"));
  const path = join(dir, "relay.log.jsonl");
  const secret = "test-secret-1234";
  const log = createLog({ path, secrets: () => [secret] });
  log.event("relay", "invite created", { invite: { secret } });
  log.event("relay", "headers", {
    headers: {
      "x-api-key": "test-secret-9876",
      authorization: "Basic test-credentials",
      accept: "application/json",
    },
  });
  const text = readFileSync(path, "utf8");
  expect(text).not.toContain(secret);
  expect(text).not.toContain("test-secret-9876");
  expect(text).not.toContain("Basic test-credentials");
  expect(text).toContain("****1234");
  expect(text).toContain("application/json");
});

test("the log rotates and tail reads the last entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "share-relay-"));
  const path = join(dir, "relay.log.jsonl");
  const log = createLog({ path, maxBytes: 180, keep: 1 });
  log.event("relay", "first");
  log.event("relay", "second", { header: "Bearer test-secret-1234" });
  log.event("relay", "third");
  expect(existsSync(path + ".1")).toBe(true);
  expect(log.tail(2).map((e) => e.message)).toEqual(["second", "third"]);
  expect(readFileSync(path, "utf8")).not.toContain("test-secret-1234");
});
