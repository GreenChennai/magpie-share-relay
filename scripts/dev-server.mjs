// 本地预览共享页：不触碰真实 magpie、真实 RN，也不读写配置。
// 用法：bun scripts/dev-server.mjs [端口]
import { fileURLToPath } from "node:url";
import { createServiceServer } from "../lib/http.mjs";
import { createApi } from "../lib/api.mjs";

const uiRoot = fileURLToPath(new URL("../ui", import.meta.url));
const port = Number(process.argv[2] || process.env.PORT || 3488);
const now = () => new Date().toISOString();

const config = {
  enabled: true,
  autoStart: true,
  publicURL: "https://us.cyanai.eu.cc/magpie",
  remotePort: 13425,
  gatewayPort: 3425,
  lanIP: "192.168.1.10",
  magpieBin: "",
  ssh: {
    host: "us.cyanai.eu.cc",
    port: 22,
    user: "root",
    keyPath: "",
    fingerprint: "",
    sudo: "auto",
  },
  nginx: {
    configRoot: "/etc/nginx",
    snippetPath: "/etc/nginx/snippets/magpie-share.conf",
    lastAppliedAt: now(),
  },
  invites: [
    {
      id: "fr_demo",
      name: "Alice",
      keyId: "k1",
      keyName: "share-alice-7f3a",
      secret: "demo-alice-not-a-real-key",
      createdAt: now(),
      revoked: false,
      limit: { period: "day", costUsd: 5, tokens: 5000000 },
    },
    {
      id: "fr_old",
      name: "Bob",
      keyId: "k2",
      keyName: "share-bob-1a2b",
      secret: "",
      createdAt: now(),
      revoked: true,
      limit: { period: "week", costUsd: 10 },
    },
  ],
};

const localChecks = [
  { id: "share", ok: true, fatal: true, detail: "Share on local network is on" },
  { id: "lan", ok: true, fatal: true, detail: "LAN address 192.168.1.10" },
  { id: "no-key", ok: true, fatal: true, detail: "a LAN request without a key was refused" },
  { id: "key", ok: true, fatal: false, detail: "the gateway answered with the key" },
  { id: "held", ok: true, fatal: false, detail: "the key cannot read whole-machine usage" },
];

const publicChecks = [
  { id: "public-no-key", ok: true, fatal: true, detail: "401" },
  { id: "public-key", ok: true, fatal: true, detail: "200, name=magpie" },
  { id: "public-admin", ok: true, fatal: true, detail: "403" },
  { id: "public-usage", ok: true, fatal: false, detail: "403" },
];

const relay = {
  status: () => ({
    state: "up",
    pid: 4242,
    since: Date.now() - 3_600_000,
    lastError: "",
    nextRetryAt: null,
  }),
  start: async () => ({ ok: true }),
  stop: async () => {},
};

const checks = {
  preflight: async () => ({ ok: true, fatal: false, checks: localChecks, at: now() }),
  public: async () => ({ ok: true, fatal: false, checks: publicChecks, at: now() }),
};

let nextInvite = 1;

const invites = {
  async create({ name, limit }) {
    const invite = {
      id: `fr_demo_${nextInvite++}`,
      name,
      keyId: `k${nextInvite}`,
      keyName: `share-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      secret: "demo-new-not-a-real-key",
      createdAt: now(),
      revoked: false,
      limit,
    };
    return { invite, warning: "" };
  },
  reveal: (cfg, id) => (cfg.invites || []).find((entry) => entry.id === id)?.secret || "",
  async rotate({ invite }) {
    return {
      ...invite,
      secret: "demo-new-not-a-real-key",
      secretMasked: undefined,
    };
  },
  async revoke({ invite }) {
    const { secret, ...rest } = invite;
    return { ...rest, revoked: true };
  },
  async updateLimit({ invite, limit }) {
    return { ...invite, limit };
  },
};

const nginx = {
  preview: () => ({
    snippet: [
      "location /magpie/ {",
      "  # 演示用片段",
      "  proxy_pass http://127.0.0.1:13425/;",
      "  proxy_buffering off;",
      "}",
    ].join("\n"),
    include: 'include snippets/magpie-share.conf;',
    script: "#!/bin/sh\n# 演示模式不会真的写 RN",
  }),
  apply: async () => ({ ok: true, appliedAt: now(), output: "MAGPIE:OK" }),
};

const log = {
  tail: (n) =>
    [
      { at: now(), kind: "relay", message: "ssh tunnel is up", pid: 4242 },
      { at: now(), kind: "probe", message: "public checks passed", checks: publicChecks.length },
      { at: now(), kind: "invite", message: "created share-alice-7f3a" },
    ].slice(0, n),
};

async function usageProbe(url, { headers } = {}) {
  const key = String(headers?.Authorization || "").replace(/^Bearer /, "");
  return {
    status: 200,
    json: {
      limited: true,
      period: "day",
      reset: new Date(Date.now() + 86_400_000).toISOString(),
      tokensLeft: key ? 4_800_000 : null,
      costLeft: key ? 4.5 : null,
    },
  };
}

const api = createApi({
  getConfig: () => config,
  saveConfig: async (next) => Object.assign(config, next),
  paths: {},
  runtime: {
    isPrimary: true,
    hasLock: true,
    port,
    configuredPort: port,
    preflight: { checks: localChecks, at: now() },
    lastPublicCheck: { ok: true, fatal: false },
    lastPublicCheckAt: Date.now() - 120_000,
  },
  relay,
  checks,
  log,
  version: "dev",
  invites,
  nginx,
  usageProbe,
});

const service = createServiceServer({ port, uiRoot, handle: api });
const actual = await service.listen();

console.log(`dev server: http://127.0.0.1:${actual}/`);
console.log("demo data only; no magpie, no SSH, no files touched.");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await service.close().catch(() => {});
    process.exit(0);
  });
}
