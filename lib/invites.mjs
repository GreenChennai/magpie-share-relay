import { randomBytes } from "node:crypto";
import { maskSecret } from "./magpie.mjs";

function slugOf(name) {
  const slug = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20);
  return slug || "friend";
}

async function removeById(magpie, id) {
  try {
    await magpie.remove(id);
    return "removed";
  } catch (err) {
    return `cleanup failed: ${String(err?.message || err)}`;
  }
}

function checkedLimit(limit) {
  const source = limit && typeof limit === "object" ? limit : {};
  const period = source.period || "day";
  if (!["day", "week", "month"].includes(period)) {
    throw new Error("limit period must be day, week or month");
  }
  const out = { period };
  if (source.costUsd !== undefined) {
    const cost = Number(source.costUsd);
    if (!Number.isFinite(cost) || cost < 0) throw new Error("limit costUsd must be a non-negative number");
    out.costUsd = cost;
  }
  if (source.tokens !== undefined) {
    const tokens = Number(source.tokens);
    if (!Number.isInteger(tokens) || tokens < 0) throw new Error("limit tokens must be a non-negative integer");
    out.tokens = tokens;
  }
  return out;
}

export async function createInvite({
  name,
  limit,
  magpie,
  verifyHeld,
  randomHex = (bytes) => randomBytes(bytes).toString("hex"),
  now = () => new Date(),
}) {
  const keyName = `share-${slugOf(name)}-${randomHex(2)}`;
  let before = null;
  try {
    before = new Set((await magpie.list()).map((row) => row.id));
  } catch {
    before = null;
  }
  let added = false;
  let row = null;
  try {
    const secret = await magpie.add(keyName);
    added = true;
    if (!secret) throw new Error("magpie did not print a secret");

    // Only a row that did not exist before this add can be ours: a name
    // collision must never authorize deleting someone else's key.
    const findOurs = (rows) => (before
      ? rows.find((entry) => entry.name === keyName && !before.has(entry.id))
      : null) || null;
    row = findOurs(await magpie.list());
    if (!row) row = findOurs(await magpie.list());
    if (!row) throw new Error(`key ${keyName} is not in magpie gateway-key list`);

    await magpie.limit(row.id, checkedLimit(limit));

    let warning = "";
    if (verifyHeld) {
      try {
        const result = await verifyHeld(secret);
        if (result?.status === 200) warning = "key 未受限，仍能看到整机用量；建议给它加每日限额";
      } catch {
        // A failed probe is not a reason to lose an otherwise good invite.
      }
    }

    return {
      invite: {
        id: `fr_${randomHex(4)}`,
        name,
        keyId: row.id,
        keyName,
        secret,
        secretMasked: maskSecret(secret),
        createdAt: now().toISOString(),
        limit: checkedLimit(limit),
        revoked: false,
      },
      warning,
    };
  } catch (err) {
    let cleaned = "not attempted";
    if (added) {
      cleaned = row
        ? await removeById(magpie, row.id)
        : "could not identify the new key; not removed";
    }
    throw new Error(`createInvite(${keyName}) failed: ${String(err?.message || err)}; cleanup: ${cleaned}`);
  }
}

export async function revokeInvite({ invite, magpie }) {
  await magpie.remove(invite.keyId);
  return { ...invite, revoked: true, secret: undefined, secretMasked: undefined };
}

export async function rotateInvite({ invite, magpie }) {
  const result = await magpie.rotate(invite.keyId);
  const secret = typeof result === "string" ? result : result?.secret;
  if (!secret) throw new Error("magpie did not print a new secret");
  return {
    invite: { ...invite, secret, secretMasked: maskSecret(secret) },
    secret,
  };
}

export async function updateInviteLimit({ invite, limit, magpie }) {
  const next = checkedLimit(limit);
  const previous = invite.limit ? checkedLimit(invite.limit) : null;
  await magpie.limitOff(invite.keyId);
  try {
    await magpie.limit(invite.keyId, next);
  } catch (err) {
    if (previous) {
      try {
        await magpie.limitOff(invite.keyId);
        await magpie.limit(invite.keyId, previous);
      } catch {
        // The error below still tells the user the limit is not what they asked for.
      }
    }
    throw err;
  }
  return { ...invite, limit: next };
}
