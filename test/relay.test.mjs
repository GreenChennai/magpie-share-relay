import { test, expect } from "bun:test";
import { createRelay } from "../lib/relay.mjs";
import { classifyStderr } from "../lib/ssh.mjs";
import { FakeChild } from "./helpers/fake-child.mjs";

const silent = { event() {} };

test("an exit waits 5s, then 10s, and a 61s life resets the wait", async () => {
  const timers = [];
  const children = [];
  let now = 0;
  const relay = createRelay({
    args: ["ssh", "-N"],
    spawn: () => { const c = new FakeChild(); children.push(c); return c; },
    log: silent,
    schedule: (ms, fn) => { timers.push({ ms, fn }); return timers.length; },
    clear: () => {},
    now: () => now,
    delays: [5, 10],
  });

  relay.start();
  now = 1000;
  children[0].exit(255);
  expect(timers.at(-1).ms).toBe(5000);

  timers.at(-1).fn();               // respawn child 1
  now = 2000;
  children[1].exit(255);
  expect(timers.at(-1).ms).toBe(10000);

  timers.at(-1).fn();               // respawn child 2
  now = 63000;
  children[2].exit(255);
  expect(timers.at(-1).ms).toBe(5000);

  await relay.stop();
  expect(relay.status().state).toBe("off");
});

test("stop kills the child and schedules no retry", async () => {
  const timers = [];
  let child;
  const relay = createRelay({
    args: ["ssh"], spawn: () => (child = new FakeChild()), log: silent,
    schedule: (ms, fn) => { timers.push({ ms, fn }); return timers.length; }, clear: () => {},
  });
  relay.start();
  await relay.stop();
  expect(child.killed).toBe(true);
  expect(timers.length).toBe(0);
  expect(relay.status().state).toBe("off");
});

test("a public 200 without a key stops the tunnel for good", async () => {
  const timers = [];
  let child;
  const relay = createRelay({
    args: ["ssh"], spawn: () => (child = new FakeChild()), log: silent,
    probe: async () => ({ ok: false, fatal: true, detail: "no-key 200" }),
    schedule: (ms, fn) => { timers.push({ ms, fn }); return timers.length; }, clear: () => {},
    probeEveryMs: 5000, startingTimeoutMs: 20000,
  });
  relay.start();
  await timers[0].fn();               // starting probe
  expect(relay.status().state).toBe("unsafe");
  expect(child.killed).toBe(true);
  expect(timers.some((t) => t.ms === 5000)).toBe(false);
});

test("stderr memory stays bounded by bytes", async () => {
  let child;
  const relay = createRelay({
    args: ["ssh"], spawn: () => (child = new FakeChild()), log: silent,
    schedule: () => 1, clear: () => {},
  });
  relay.start();
  child.stderr.emit("data", "x".repeat(200000) + "\n");
  expect(relay.status().lastError.length).toBeLessThanOrEqual(4096);
  for (let i = 0; i < 5000; i++) child.stderr.emit("data", `line ${i} ${"y".repeat(100)}\n`);
  expect(relay.status().lastError.length).toBeLessThanOrEqual(4096);
  await relay.stop();
});

test("an ssh stderr line becomes a readable hint", async () => {
  let child;
  const relay = createRelay({
    args: ["ssh"], spawn: () => (child = new FakeChild()), log: silent,
    schedule: () => 1, clear: () => {},
    classify: classifyStderr,
  });
  relay.start();
  child.stderr.emit("data", "Permission denied (publickey).\n");
  child.exit(255);
  expect(relay.status().lastHint.kind).toBe("publickey");
  expect(relay.status().lastHint.message).toContain("公钥");
  expect(relay.status().lastHint.hint).toContain("authorized_keys");
  await relay.stop();
});

test("prepare runs before every spawn and a fatal failure stops retries", async () => {
  const timers = [];
  const children = [];
  let prepared = 0;
  const relay = createRelay({
    args: ["fallback"],
    prepare: async () => {
      prepared += 1;
      if (prepared === 1) return ["ssh", "-N", "root@rn"];
      const err = new Error("the gateway answers without a key");
      err.fatal = true;
      throw err;
    },
    spawn: (argv) => {
      const child = new FakeChild();
      child.argv = argv;
      children.push(child);
      return child;
    },
    log: silent,
    schedule: (ms, fn) => { timers.push({ ms, fn }); return timers.length; },
    clear: () => {},
  });

  const started = relay.start();
  await started;
  expect(children.length).toBe(1);
  expect(children[0].argv).toEqual(["ssh", "-N", "root@rn"]);

  children[0].exit(255);
  expect(timers.at(-1).ms).toBe(5000);
  await timers.at(-1).fn();               // retry: prepare now fails fatally
  expect(children.length).toBe(1);
  expect(relay.status().state).toBe("preflight_failed");
  expect(timers.length).toBe(1);
});

test("a failed prepare backs off and recovers", async () => {
  const timers = [];
  const children = [];
  let prepared = 0;
  let fail = true;
  const relay = createRelay({
    args: ["ssh"],
    prepare: async () => {
      prepared += 1;
      if (fail) throw new Error("no LAN IP answered");
      return ["ssh", "-N"];
    },
    spawn: () => { const child = new FakeChild(); children.push(child); return child; },
    log: silent,
    schedule: (ms, fn) => { timers.push({ ms, fn }); return timers.length; },
    clear: () => {},
  });

  const started = relay.start();
  await started;
  expect(prepared).toBe(1);
  expect(children.length).toBe(0);
  expect(relay.status().state).toBe("backoff");
  expect(timers.at(-1).ms).toBe(5000);

  fail = false;
  await timers.at(-1).fn();
  expect(prepared).toBe(2);
  expect(children.length).toBe(1);
  expect(relay.status().state).toBe("starting");
  await relay.stop();
});

test("markPreflightFailed reports without a spawn and start recovers", () => {
  const children = [];
  const relay = createRelay({
    args: ["ssh"],
    spawn: () => { const child = new FakeChild(); children.push(child); return child; },
    log: silent,
    schedule: () => 1,
    clear: () => {},
  });

  expect(relay.markPreflightFailed("no LAN IP answered")).toBe(true);
  expect(relay.status().state).toBe("preflight_failed");
  expect(relay.status().lastError).toContain("no LAN IP");
  expect(children.length).toBe(0);

  relay.start();
  expect(children.length).toBe(1);
  expect(relay.status().state).toBe("starting");
});

test("two failed probes degrade, one success recovers", async () => {
  const timers = [];
  let result = { ok: true };
  const relay = createRelay({
    args: ["ssh"], spawn: () => new FakeChild(), log: silent,
    probe: async () => result,
    schedule: (ms, fn) => { timers.push({ ms, fn }); return timers.length; }, clear: () => {},
    probeEveryMs: 5000, upEveryMs: 60000, degradedAfter: 2,
  });
  relay.start();
  await timers.shift().fn();          // starting -> up
  result = { ok: false };
  await timers.shift().fn();
  await timers.shift().fn();
  expect(relay.status().state).toBe("degraded");
  result = { ok: true };
  await timers.shift().fn();
  expect(relay.status().state).toBe("up");
});

test("a spawn error backs off instead of crashing the host", () => {
  const timers = [];
  let child;
  const relay = createRelay({
    args: ["ssh"], spawn: () => (child = new FakeChild()), log: silent,
    schedule: (ms, fn) => { timers.push({ ms, fn }); return timers.length; }, clear: () => {},
    delays: [5],
  });
  relay.start();
  child.emit("error", Object.assign(new Error('Executable not found in $PATH: "ssh"'), { code: "ENOENT" }));
  expect(relay.status().state).toBe("backoff");
  expect(relay.status().lastError).toContain("Executable not found");
  expect(relay.status().attempts).toBe(1);
  expect(timers.at(-1).ms).toBe(5000);
});
