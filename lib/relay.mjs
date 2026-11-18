import { redact } from "./log.mjs";

// createRelay owns one ssh process: it starts it, waits out a failed one
// with backoff, and kills it on stop. Health probing is Task 7's.
export function createRelay({
  args,
  spawn,
  log,
  schedule = (ms, fn) => setTimeout(fn, ms),
  clear = clearTimeout,
  now = Date.now,
  delays = [5, 10, 20, 40, 80, 160, 300],
  liveResetMs = 60000,
  probe,
  probeEveryMs = 5000,
  upEveryMs = 60000,
  startingTimeoutMs = 20000,
  degradedAfter = 2,
  prepare,
  classify,
}) {
  let state = "off";
  let since = now();
  let child = null;
  let attempt = 0;
  let retryTimer = null;
  let nextRetryAt = null;
  let lastError = "";
  let lastHint = null;
  let lastExit = null;
  let stopping = false;
  let stopWait = null;
  let healthTimer = null;
  let healthGeneration = 0;
  let startingAt = 0;
  let failures = 0;
  let spawnGeneration = 0;
  let preparing = false;

  function setState(next) {
    state = next;
    since = now();
  }

  function cancelProbe() {
    healthGeneration += 1;
    if (healthTimer !== null) {
      try { clear(healthTimer); } catch { /* already fired */ }
      healthTimer = null;
    }
  }

  function scheduleProbe(ms) {
    const generation = healthGeneration;
    healthTimer = schedule(ms, () => probeOnce(generation));
  }

  function enterUnsafe(detail) {
    cancelProbe();
    setState("unsafe");
    nextRetryAt = null;
    lastError = redact(String(detail || "public URL is reachable without a key"));
    log?.event?.("relay", "unsafe", { detail: lastError });
    try { child?.kill?.(); } catch { /* already gone */ }
  }

  async function probeOnce(generation) {
    if (generation !== healthGeneration) return;
    healthTimer = null;
    if (!child || state === "off" || state === "backoff" || state === "unsafe") return;

    let result;
    try {
      result = await probe();
    } catch (err) {
      result = { ok: false, detail: String(err?.message || err) };
    }
    if (generation !== healthGeneration || !child) return;
    if (result?.fatal) {
      enterUnsafe(result.detail);
      return;
    }

    if (state === "starting") {
      if (result?.ok) {
        failures = 0;
        setState("up");
        scheduleProbe(upEveryMs);
      } else if (now() - startingAt >= startingTimeoutMs) {
        lastError = "tunnel did not come up";
        log?.event?.("relay", "tunnel did not come up", { afterMs: now() - startingAt });
        try { child.kill?.(); } catch { /* already gone */ }
      } else {
        scheduleProbe(probeEveryMs);
      }
      return;
    }

    if (state === "up" || state === "degraded") {
      if (result?.ok) {
        failures = 0;
        if (state !== "up") setState("up");
      } else {
        failures += 1;
        if (failures >= degradedAfter) setState("degraded");
      }
      scheduleProbe(upEveryMs);
    }
  }

  function scheduleRetry(livedMs, exit = {}) {
    if (livedMs >= liveResetMs) attempt = 0;
    const list = delays.length ? delays : [300];
    const seconds = list[Math.min(attempt, list.length - 1)];
    attempt += 1;
    nextRetryAt = now() + seconds * 1000;
    setState("backoff");
    log?.event?.("relay", "ssh exited", { livedMs, retryInMs: seconds * 1000, ...exit });
    retryTimer = schedule(seconds * 1000, () => {
      retryTimer = null;
      return spawnOnce();
    });
  }

  function onExit(exited, code, signal, startedAt) {
    if (child !== exited) return;
    child = null;
    cancelProbe();
    lastExit = { code, signal, at: now() };
    if (stopping) {
      setState("off");
      if (stopWait) stopWait.resolve();
      else stopping = false;
      return;
    }
    if (state === "unsafe") return;
    scheduleRetry(now() - startedAt, { code, signal });
  }

  function launch(argv) {
    let started;
    try {
      started = spawn(argv);
    } catch (err) {
      lastError = redact(String(err?.message || err));
      scheduleRetry(0);
      return;
    }
    child = started;
    nextRetryAt = null;
    setState("starting");
    const startedAt = now();

    let stderrBuf = "";
    let stderrLines = [];
    started.stderr?.on?.("data", (chunk) => {
      // ssh can emit a megabyte without a newline; keep only the tail that
      // a reader would actually need, by bytes as well as by line count.
      stderrBuf += String(chunk);
      if (stderrBuf.length > 16384) stderrBuf = stderrBuf.slice(-8192);
      const parts = stderrBuf.split(/\r?\n/);
      stderrBuf = parts.pop() ?? "";
      if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192);
      for (const line of parts) {
        if (!line) continue;
        stderrLines.push(line.length > 2048 ? line.slice(-2048) : line);
        if (stderrLines.length > 20) stderrLines.shift();
      }
      if (parts.length) {
        const text = stderrLines.join("\n").slice(-4096);
        lastError = redact(text);
        if (classify) {
          try {
            lastHint = classify(text);
          } catch {
            lastHint = null;
          }
        }
      }
    });

    started.on?.("error", (err) => {
      if (child !== started) return;
      lastError = redact(String(err?.message || err));
      if (classify) {
        try { lastHint = classify(lastError); } catch { lastHint = null; }
      }
      log?.event?.("relay", "ssh could not start", { detail: lastError });
      onExit(started, undefined, undefined, startedAt);
    });

    started.on?.("exit", (code, signal) => onExit(started, code, signal, startedAt));

    if (probe) {
      startingAt = startedAt;
      failures = 0;
      scheduleProbe(0);
    }
  }

  function spawnOnce() {
    if (stopping || child || preparing) return Promise.resolve();
    retryTimer = null;
    cancelProbe();

    if (!prepare) {
      launch(args);
      return Promise.resolve();
    }

    const generation = ++spawnGeneration;
    preparing = true;
    return Promise.resolve()
      .then(() => prepare())
      .then(
        (argv) => {
          preparing = false;
          if (generation !== spawnGeneration || stopping || child) return;
          launch(Array.isArray(argv) ? argv : args);
        },
        (err) => {
          preparing = false;
          if (generation !== spawnGeneration || stopping) return;
          lastError = redact(String(err?.message || err));
          if (err?.fatal) {
            cancelProbe();
            setState("preflight_failed");
            nextRetryAt = null;
            log?.event?.("relay", "preflight failed", { detail: lastError });
            return;
          }
          scheduleRetry(0);
        },
      );
  }

  function markPreflightFailed(detail) {
    if (child || stopping || preparing) return false;
    cancelProbe();
    setState("preflight_failed");
    nextRetryAt = null;
    lastError = redact(String(detail || "preflight failed"));
    log?.event?.("relay", "preflight failed", { detail: lastError });
    return true;
  }

  function start() {
    if (child || stopping || preparing) return Promise.resolve();
    if (retryTimer !== null) {
      try { clear(retryTimer); } catch { /* already fired */ }
      retryTimer = null;
    }
    attempt = 0;
    return spawnOnce();
  }

  function stop() {
    if (stopping) return Promise.resolve();
    stopping = true;
    spawnGeneration += 1;
    preparing = false;
    cancelProbe();
    if (retryTimer !== null) {
      try { clear(retryTimer); } catch { /* already fired */ }
      retryTimer = null;
    }
    if (!child) {
      setState("off");
      stopping = false;
      return Promise.resolve();
    }
    const current = child;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        stopWait = null;
        child = null;
        setState("off");
        stopping = false;
        try { current.kill?.(); } catch { /* already gone */ }
        resolve();
      }, 5000);
      stopWait = {
        resolve: () => {
          clearTimeout(timer);
          stopWait = null;
          child = null;
          setState("off");
          stopping = false;
          resolve();
        },
      };
      try {
        current.kill?.();
      } catch {
        stopWait.resolve();
      }
    });
  }

  function status() {
    return {
      state,
      pid: child?.pid ?? null,
      since,
      attempts: attempt,
      nextRetryAt,
      lastError,
      lastHint,
      lastExit,
    };
  }

  return { start, stop, status, markPreflightFailed };
}
