import { test, expect } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, releaseLock } from "../lib/lock.mjs";

test("a stale pid is replaced, a live one is not", () => {
  const lockPath = join(mkdtempSync(join(tmpdir(), "share-relay-")), "relay.lock");
  const alive = new Set([111]);
  const isAlive = (pid) => alive.has(pid);
  expect(acquireLock({ lockPath, pid: 111, isAlive })).toBe(true);
  expect(acquireLock({ lockPath, pid: 222, isAlive })).toBe(false);
  alive.delete(111);
  expect(acquireLock({ lockPath, pid: 333, isAlive })).toBe(true);
  releaseLock({ lockPath, pid: 333 });
  expect(acquireLock({ lockPath, pid: 444, isAlive })).toBe(true);
});

test("a just-created empty lock file is not treated as stale", () => {
  const lockPath = join(mkdtempSync(join(tmpdir(), "share-relay-")), "relay.lock");
  writeFileSync(lockPath, "");
  expect(acquireLock({ lockPath, pid: 222, isAlive: () => false })).toBe(false);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockPath, old, old);
  expect(acquireLock({ lockPath, pid: 333, isAlive: () => false })).toBe(true);
});
