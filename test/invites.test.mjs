import { test, expect } from "bun:test";
import { createInvite, revokeInvite, rotateInvite, updateInviteLimit } from "../lib/invites.mjs";

test("a failed add never removes an existing key with the same name", async () => {
  const removed = [];
  const magpie = {
    async add() { throw new Error("add failed"); },
    async list() { return [{ id: "old", name: "share-alice-7f3a" }]; },
    async limit() {},
    async remove(id) { removed.push(id); },
  };
  await expect(createInvite({
    name: "Alice", limit: { period: "day" }, magpie,
    randomHex: () => "7f3a",
  })).rejects.toThrow(/share-alice-7f3a/);
  expect(removed).toEqual([]);
});

test("cleanup removes only the id this call added", async () => {
  const removed = [];
  let addedFlag = false;
  const magpie = {
    async add() { addedFlag = true; return "test-secret-1234"; },
    async list() {
      return [
        { id: "old", name: "share-alice-7f3a" },
        ...(addedFlag ? [{ id: "new", name: "share-alice-7f3a" }] : []),
      ];
    },
    async limit() { throw new Error("limit failed"); },
    async remove(id) { removed.push(id); },
  };
  await expect(createInvite({
    name: "Alice", limit: { period: "day" }, magpie,
    randomHex: () => "7f3a",
  })).rejects.toThrow(/share-alice-7f3a/);
  expect(removed).toEqual(["new"]);
});

test("an invalid limit is refused before the old one is cleared", async () => {
  const calls = [];
  const magpie = {
    async limitOff() { calls.push("off"); },
    async limit() { calls.push("limit"); },
  };
  await expect(updateInviteLimit({
    invite: { keyId: "k1", limit: { period: "day" } },
    limit: { period: "year" },
    magpie,
  })).rejects.toThrow();
  expect(calls).toEqual([]);
});

test("a failed limit change restores the previous limit", async () => {
  const calls = [];
  let first = true;
  const magpie = {
    async limitOff(id) { calls.push(["off", id]); },
    async limit(id, spec) {
      calls.push(["limit", id, spec]);
      if (first) {
        first = false;
        throw new Error("gateway said no");
      }
    },
  };
  const invite = { keyId: "k1", limit: { period: "day", costUsd: 5 } };
  await expect(updateInviteLimit({
    invite,
    limit: { period: "week", costUsd: 2 },
    magpie,
  })).rejects.toThrow(/gateway said no/);
  expect(calls).toEqual([
    ["off", "k1"],
    ["limit", "k1", { period: "week", costUsd: 2 }],
    ["off", "k1"],
    ["limit", "k1", { period: "day", costUsd: 5 }],
  ]);
});

test("a new friend gets a held key and a masked secret", async () => {
  const calls = [];
  let added = false;
  const magpie = {
    async add(name) { calls.push(["add", name]); added = true; return "test-secret-1234"; },
    async list() { return added ? [{ id: "k1", name: "share-alice-7f3a", state: "enabled" }] : []; },
    async limit(id, spec) { calls.push(["limit", id, spec]); },
  };
  const r = await createInvite({
    name: "Alice",
    limit: { period: "day", costUsd: 5 },
    magpie,
    verifyHeld: async () => ({ status: 403 }),
    randomHex: () => "7f3a",
    now: () => new Date("2026-11-18T06:00:00Z"),
  });
  expect(r.invite.keyId).toBe("k1");
  expect(r.invite.secret).toBe("test-secret-1234");
  expect(r.invite.secretMasked).toBe("****1234");
  expect(r.warning).toBe("");
  expect(calls.map((c) => c[0])).toEqual(["add", "limit"]);
});

test("revoking removes the key and drops the secret", async () => {
  const calls = [];
  const invite = { id: "fr_1", keyId: "k1", secret: "test-secret-1234", revoked: false };
  const out = await revokeInvite({ invite, magpie: { async remove(id) { calls.push(id); } } });
  expect(calls).toEqual(["k1"]);
  expect(out.revoked).toBe(true);
  expect(out.secret).toBeUndefined();
});

test("a 200 from the usage probe warns that the key is unheld", async () => {
  let added = false;
  const magpie = {
    async add() { added = true; return "test-secret-1234"; },
    async list() { return added ? [{ id: "k1", name: "share-alice-7f3a", state: "enabled" }] : []; },
    async limit() {},
  };
  const r = await createInvite({
    name: "Alice", limit: { period: "day" }, magpie,
    verifyHeld: async () => ({ status: 200 }),
    randomHex: () => "7f3a",
  });
  expect(r.warning).toContain("整机用量");
});

test("a failure after add removes the half-created key and names it", async () => {
  const calls = [];
  let added = false;
  const magpie = {
    async add() { calls.push("add"); added = true; return "test-secret-1234"; },
    async list() { return added ? [{ id: "k1", name: "share-alice-7f3a", state: "enabled" }] : []; },
    async limit() { throw new Error("limit failed"); },
    async remove(id) { calls.push(["remove", id]); },
  };
  await expect(createInvite({
    name: "Alice", limit: { period: "day" }, magpie,
    randomHex: () => "7f3a",
  })).rejects.toThrow(/share-alice-7f3a/);
  expect(calls).toContainEqual(["remove", "k1"]);
});

test("rotate returns a new secret and update writes both limit commands", async () => {
  const calls = [];
  const magpie = {
    async rotate(id) { calls.push(["rotate", id]); return "test-secret-9876"; },
    async limitOff(id) { calls.push(["off", id]); },
    async limit(id, spec) { calls.push(["limit", id, spec]); },
  };
  const invite = { id: "fr_1", keyId: "k1", secret: "test-secret-1234", limit: { period: "day" }, revoked: false };
  const turned = await rotateInvite({ invite, magpie });
  expect(turned.secret).toBe("test-secret-9876");
  expect(turned.invite.secretMasked).toBe("****9876");

  const limited = await updateInviteLimit({ invite, limit: { period: "week", costUsd: 2 }, magpie });
  expect(limited.limit).toEqual({ period: "week", costUsd: 2 });
  expect(calls).toContainEqual(["off", "k1"]);
  expect(calls).toContainEqual(["limit", "k1", { period: "week", costUsd: 2 }]);
});
