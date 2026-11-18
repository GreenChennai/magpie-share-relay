import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runCommand } from "./exec.mjs";

export function findBinary(name) {
  const override = name === "ssh"
    ? process.env.MAGPIE_SHARE_SSH
    : name === "ssh-keygen"
      ? process.env.MAGPIE_SHARE_SSH_KEYGEN
      : "";
  if (override && override.trim()) return override.trim();

  const finder = process.platform === "win32" ? "where.exe" : "which";
  const found = spawnSync(finder, [name], { encoding: "utf8", windowsHide: true });
  if (found.status === 0) {
    const first = String(found.stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (first) return first;
  }
  if (process.platform === "win32") {
    const fallback = join(process.env.SystemRoot || "C:\\Windows", "System32", "OpenSSH", name + ".exe");
    if (existsSync(fallback)) return fallback;
  }
  return name;
}

function knownHostsOption(path) {
  return /\s/.test(path) ? `UserKnownHostsFile="${path}"` : `UserKnownHostsFile=${path}`;
}

export function buildTunnelArgs({ ssh, remotePort, lanIP, gatewayPort, keyPath, knownHostsPath }) {
  return [
    ssh.bin || "ssh",
    "-N",
    "-T",
    "-i", keyPath,
    "-p", String(ssh.port ?? 22),
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "TCPKeepAlive=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", knownHostsOption(knownHostsPath),
    "-R", `127.0.0.1:${remotePort}:${lanIP}:${gatewayPort}`,
    `${ssh.user}@${ssh.host}`,
  ];
}

export function buildRemoteArgs({ ssh, keyPath, knownHostsPath }) {
  return [
    ssh.bin || "ssh",
    "-i", keyPath,
    "-p", String(ssh.port ?? 22),
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", knownHostsOption(knownHostsPath),
    `${ssh.user}@${ssh.host}`,
    "sh", "-s",
  ];
}

const RULES = [
  [/Permission denied \(publickey\)/i, "publickey",
    "RN 还没授权这把公钥", "把页面上的公钥加到 RN 的 ~/.ssh/authorized_keys（复制页面给出的命令即可）。"],
  [/remote port forwarding failed/i, "port_in_use",
    "RN 上的转发端口被占用", "换一个 remotePort，或停掉 RN 上占用该端口的进程。"],
  [/administratively prohibited/i, "forwarding_disabled",
    "RN 的 sshd 禁止端口转发", "在 RN 的 /etc/ssh/sshd_config 设 AllowTcpForwarding yes，再重启 sshd。"],
  [/Host key verification failed/i, "host_key",
    "RN 的主机指纹变了", "先核对指纹；确认无误后删除 known_hosts 里对应条目，重启共享。"],
  [/Could not resolve hostname/i, "dns",
    "无法解析 RN 的主机名", "检查 ssh.host 和本机 DNS。"],
  [/Connection timed out|Operation timed out|timed out/i, "timeout",
    "连接 RN 超时", "检查网络、防火墙和 ssh.port。"],
  [/Connection refused/i, "refused",
    "RN 拒绝连接", "检查 sshd 是否在 ssh.port 上监听。"],
  [/Executable not found in \$PATH|ENOENT|not recognized as an internal or external command/i, "ssh-missing",
    "本机找不到 ssh 可执行文件", "把配置里的 ssh.bin 设成 ssh.exe 的完整路径，例如 Git 的 usr/bin/ssh.exe。"],
];

export function classifyStderr(text) {
  const value = String(text || "");
  for (const [pattern, kind, message, hint] of RULES) {
    if (pattern.test(value)) return { kind, message, hint };
  }
  return { kind: "unknown", message: "SSH 退出", hint: "查看日志里的 stderr 最后几行。" };
}

function shQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

export function authorizeCommand(publicKey) {
  const key = shQuote(publicKey);
  return `mkdir -p ~/.ssh && chmod 700 ~/.ssh && k=${key} && { grep -qxF "$k" ~/.ssh/authorized_keys 2>/dev/null || printf '%s\\n' "$k" >> ~/.ssh/authorized_keys; } && chmod 600 ~/.ssh/authorized_keys`;
}

export async function ensureKey({ keyPath, comment = "magpie-share-relay", run = runCommand }) {
  if (!keyPath) throw new Error("a key path is required");
  mkdirSync(dirname(keyPath), { recursive: true });
  const pubPath = keyPath + ".pub";
  const keygen = findBinary("ssh-keygen");

  if (existsSync(keyPath) && existsSync(pubPath)) {
    return { publicKey: readFileSync(pubPath, "utf8").trim(), created: false };
  }

  if (existsSync(keyPath)) {
    const result = await run([keygen, "-y", "-f", keyPath], { timeoutMs: 15000 });
    if (result.code !== 0) {
      throw new Error(`ssh-keygen could not read ${keyPath}: ${(result.stderr || result.stdout).trim()}`);
    }
    const publicKey = result.stdout.trim();
    writeFileSync(pubPath, publicKey + "\n", { mode: 0o644 });
    return { publicKey, created: false };
  }

  const result = await run([keygen, "-t", "ed25519", "-N", "", "-C", comment, "-f", keyPath], { timeoutMs: 15000 });
  if (result.code !== 0) {
    throw new Error(`ssh-keygen failed: ${(result.stderr || result.stdout).trim()}`);
  }
  if (!existsSync(pubPath)) throw new Error(`ssh-keygen did not write ${pubPath}`);
  return { publicKey: readFileSync(pubPath, "utf8").trim(), created: true };
}

export async function fingerprintOf({ knownHostsPath, run = runCommand }) {
  if (!knownHostsPath || !existsSync(knownHostsPath)) return "";
  const result = await run([findBinary("ssh-keygen"), "-lf", knownHostsPath], { timeoutMs: 10000 });
  if (result.code !== 0) return "";
  const match = /SHA256:[A-Za-z0-9+/=]+/.exec(result.stdout);
  return match ? match[0] : "";
}

export async function runRemote({ ssh, keyPath, knownHostsPath, script, timeoutMs = 20000, run = runCommand }) {
  const result = await run(buildRemoteArgs({ ssh, keyPath, knownHostsPath }), { stdin: script, timeoutMs });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}
