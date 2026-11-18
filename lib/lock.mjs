import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";

const FRESH_LOCK_MS = 10000;

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// acquireLock makes the file with O_EXCL, so exactly one process wins. A
// lock whose pid is gone is stale and replaced; a live one is left alone.
export function acquireLock({ lockPath, pid = process.pid, isAlive = isProcessAlive }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let holder = null;
      try {
        holder = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch {
        holder = null;
        // A lock just created by another process may not have its pid yet.
        try {
          if (Date.now() - statSync(lockPath).mtimeMs < FRESH_LOCK_MS) return false;
        } catch {
          // The file vanished; fall through and try to take the lock.
        }
      }
      if (holder && isAlive(Number(holder.pid))) return false;
      try {
        unlinkSync(lockPath);
      } catch (unlinkErr) {
        if (unlinkErr.code !== "ENOENT") throw unlinkErr;
      }
      continue;
    }
    try {
      writeSync(fd, JSON.stringify({ pid, startedAt: new Date().toISOString() }));
    } finally {
      closeSync(fd);
    }
    return true;
  }
  return false;
}

export function releaseLock({ lockPath, pid = process.pid }) {
  let holder;
  try {
    holder = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return;
  }
  if (Number(holder?.pid) !== pid) return;
  try {
    unlinkSync(lockPath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}
