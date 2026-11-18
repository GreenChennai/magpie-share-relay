import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeCommand,
  buildRemoteArgs,
  buildTunnelArgs,
  classifyStderr,
  ensureKey,
  findBinary,
  fingerprintOf,
  runRemote,
} from "../lib/ssh.mjs";

const keygen = findBinary("ssh-keygen");
const hasKeygen = !spawnSync(keygen, ["-?"], { windowsHide: true }).error;

test("the tunnel binds RN loopback and targets the LAN IP", () => {
  const args = buildTunnelArgs({
    ssh: { host: "us.cyanai.eu.cc", port: 22, user: "root" },
    remotePort: 13425,
    lanIP: "192.168.66.6",
    gatewayPort: 3425,
    keyPath: "C:\\Users\\me\\.config\\magpie\\share-relay\\id_ed25519",
    knownHostsPath: "C:\\Users\\me\\.config\\magpie\\share-relay\\known_hosts",
  });
  expect(args[args.indexOf("-R") + 1]).toBe("127.0.0.1:13425:192.168.66.6:3425");
  expect(args).toContain("-N");
  expect(args).toContain("-T");
  expect(args).toContain("ExitOnForwardFailure=yes");
  expect(args.at(-1)).toBe("root@us.cyanai.eu.cc");
});

test("stderr maps to an actionable kind", () => {
  expect(classifyStderr("Permission denied (publickey).").kind).toBe("publickey");
  expect(classifyStderr("remote port forwarding failed for listen port 13425").kind).toBe("port_in_use");
  expect(classifyStderr("administratively prohibited").kind).toBe("forwarding_disabled");
  expect(classifyStderr("Host key verification failed.").kind).toBe("host_key");
  expect(classifyStderr("Could not resolve hostname").kind).toBe("dns");
});

test("the authorize command carries the public key once", () => {
  const cmd = authorizeCommand("ssh-ed25519 AAAA test@host");
  expect(cmd).toContain("mkdir -p ~/.ssh");
  expect(cmd).toContain("ssh-ed25519 AAAA test@host");
  expect(cmd).toContain("chmod 600 ~/.ssh/authorized_keys");
});

test("the remote command is batch mode and runs sh -s", () => {
  const args = buildRemoteArgs({
    ssh: { host: "us.cyanai.eu.cc", port: 22, user: "root" },
    keyPath: "key",
    knownHostsPath: "known",
  });
  expect(args[0]).toBe("ssh");
  expect(args).toContain("BatchMode=yes");
  expect(args).toContain("UserKnownHostsFile=known");
  expect(args.slice(-2)).toEqual(["sh", "-s"]);
  expect(args.at(-3)).toBe("root@us.cyanai.eu.cc");
});

test("runRemote sends the script over stdin", async () => {
  let seen;
  const r = await runRemote({
    ssh: { host: "h", port: 22, user: "u" },
    keyPath: "key",
    knownHostsPath: "known",
    script: "echo hi",
    run: async (argv, opts) => {
      seen = { argv, opts };
      return { code: 0, stdout: "ok", stderr: "" };
    },
  });
  expect(seen.opts.stdin).toBe("echo hi");
  expect(seen.argv.slice(-2)).toEqual(["sh", "-s"]);
  expect(r).toEqual({ code: 0, stdout: "ok", stderr: "" });
});

test.skipIf(!hasKeygen)("ensureKey creates a key and then reuses it", async () => {
  const keyPath = join(mkdtempSync(join(tmpdir(), "share-relay-")), "id_ed25519");
  const first = await ensureKey({ keyPath });
  expect(first.created).toBe(true);
  expect(first.publicKey.startsWith("ssh-ed25519 ")).toBe(true);

  const again = await ensureKey({ keyPath });
  expect(again.created).toBe(false);
  expect(again.publicKey).toBe(first.publicKey);

  unlinkSync(keyPath + ".pub");
  const restored = await ensureKey({ keyPath });
  expect(restored.created).toBe(false);
  expect(restored.publicKey.split(" ").slice(0, 2)).toEqual(first.publicKey.split(" ").slice(0, 2));
  expect(readFileSync(keyPath + ".pub", "utf8").trim().startsWith("ssh-ed25519 ")).toBe(true);
});

test.skipIf(!hasKeygen)("fingerprintOf reads the first SHA256 fingerprint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "share-relay-"));
  const keyPath = join(dir, "id_ed25519");
  await ensureKey({ keyPath });
  const knownHostsPath = join(dir, "known_hosts");
  writeFileSync(knownHostsPath, readFileSync(keyPath + ".pub", "utf8"));
  expect(await fingerprintOf({ knownHostsPath })).toMatch(/^SHA256:[A-Za-z0-9+/=]+$/);
  expect(await fingerprintOf({ knownHostsPath: join(dir, "missing") })).toBe("");
});
