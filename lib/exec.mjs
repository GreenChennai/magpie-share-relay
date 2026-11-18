import { spawn } from "node:child_process";

const LIMIT = 1 << 20;

// runCommand is the one place a child process is started: no shell, no
// window, stdin closed after the caller's bytes, and a timeout that kills
// the child instead of leaving it behind.
export function runCommand(argv, { stdin = "", timeoutMs = 15000, env, cwd } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let child;

    try {
      child = spawn(argv[0], argv.slice(1), {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: env ?? process.env,
        cwd,
      });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: "", timedOut: false, error: String(err?.message || err) });
      return;
    }

    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch { /* already gone */ }
      }, timeoutMs)
      : null;

    child.stdout.on("data", (chunk) => {
      if (stdout.length < LIMIT) stdout += chunk.toString("utf8").slice(0, LIMIT - stdout.length);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < LIMIT) stderr += chunk.toString("utf8").slice(0, LIMIT - stderr.length);
    });
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    child.stdin.on("error", () => {});

    try {
      if (stdin) child.stdin.write(stdin);
      child.stdin.end();
    } catch {
      // The child may have exited before its stdin was written; its exit
      // code and stderr are the answer, not this.
    }

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr, timedOut, error: String(err?.message || err) });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}
