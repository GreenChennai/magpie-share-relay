import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicPath, renderSnippet, findConflict, buildApplyScript, serverNameOf } from "../lib/nginx.mjs";

function runApply(configText, serverName = "magpie.example", extraFiles = {}) {
  const root = mkdtempSync(join(tmpdir(), "nginx-apply-")).replaceAll("\\", "/");
  const at = (...parts) => root + "/" + parts.join("/");
  const bin = at("bin");
  const snippets = at("snippets");
  mkdirSync(bin);
  mkdirSync(snippets);
  mkdirSync(at("sites"));
  const file = at("sites", "sites.conf");
  writeFileSync(file, configText);
  for (const [rel, text] of Object.entries(extraFiles)) {
    writeFileSync(at(rel), text);
  }
  for (const name of ["sudo", "nginx", "systemctl"]) {
    const body = name === "sudo"
      ? "#!/bin/sh\nif [ \"$1\" = \"-n\" ]; then shift; fi\nexec \"$@\"\n"
      : name === "nginx"
        ? `#!/bin/sh\nif [ "$1" = "-T" ]; then printf '# configuration file %s:\\n' '${file}'; fi\nexit 0\n`
        : "#!/bin/sh\nexit 0\n";
    writeFileSync(at("bin", name), body);
    chmodSync(at("bin", name), 0o755);
  }
  const snippetPath = at("snippets", "magpie-share.conf");
  const script = buildApplyScript({
    snippet: "location /magpie/ { proxy_pass http://127.0.0.1:13425/; }",
    snippetPath,
    configRoot: root,
    serverName,
  });
  const path = [bin, process.env.PATH].join(process.platform === "win32" ? ";" : ":");
  const exec = () => Bun.spawnSync({
    cmd: ["sh", "-s"],
    stdin: new TextEncoder().encode(script),
    env: { ...process.env, PATH: path },
  });
  const result = exec();
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    file,
    text: readFileSync(file, "utf8"),
    snippetPath,
    applyAgain: () => {
      const again = exec();
      return {
        status: again.exitCode,
        stdout: again.stdout.toString(),
        stderr: again.stderr.toString(),
        text: readFileSync(file, "utf8"),
      };
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("the snippet refuses a root prefix and keeps the trailing slash", () => {
  expect(() => publicPath("https://us.cyanai.eu.cc/")).toThrow();
  expect(publicPath("https://us.cyanai.eu.cc/magpie/")).toBe("/magpie");
  const s = renderSnippet({ publicURL: "https://us.cyanai.eu.cc/magpie", remotePort: 13425 });
  expect(s).toContain("location ~ ^/magpie/v1/magpie/(admin|usage)(/|$)");
  expect(s).toContain("proxy_pass http://127.0.0.1:13425/;");
  expect(s).toContain("proxy_buffering off;");
});

test("nginx -T's own snippet is not a conflict", () => {
  const snippetPath = "/etc/nginx/snippets/magpie-share.conf";
  const t = [
    "# configuration file /etc/nginx/sites-enabled/us.conf:",
    "server { location /magpie/ { proxy_pass http://127.0.0.1:1/; } }",
    "# configuration file " + snippetPath + ":",
    "location /magpie/ { proxy_pass http://127.0.0.1:13425/; }",
  ].join("\n");
  expect(findConflict(t, "/magpie", snippetPath).found).toBe(true);
  expect(findConflict(t, "/magpie", snippetPath).lines.length).toBe(1);
});

test("the apply script backs up, tests and rolls back", () => {
  const sh = buildApplyScript({
    snippet: "location /magpie/ { }",
    snippetPath: "/etc/nginx/snippets/magpie-share.conf",
    configRoot: "/etc/nginx",
    serverName: "us.cyanai.eu.cc",
  });
  expect(sh).toContain("set -eu");
  expect(sh).toContain("cp -a");
  expect(sh).toContain("nginx -t");
  expect(sh).toContain("systemctl reload nginx");
  expect(sh).toContain("MAGPIE:OK");
  expect(sh).toContain("MAGPIE:CONFLICT");
  expect(sh).toContain("MAGPIE:NO_SERVER");
  expect(sh).toContain("MAGPIE:NOT_TLS");
  expect(sh).toContain("MAGPIE:SUDO");
});

test("a hostname that could break out of the shell is refused", () => {
  for (const publicURL of [
    "https://x%60uname%60.example/magpie",
    "https://x%22y.example/magpie",
    "https://x$(id).example/magpie",
  ]) {
    expect(() => serverNameOf(publicURL)).toThrow();
  }
  expect(serverNameOf("https://xn--bcher-kva.example/magpie")).toBe("xn--bcher-kva.example");
  expect(() => buildApplyScript({
    snippet: "location /magpie/ { }",
    snippetPath: "/etc/nginx/snippets/magpie-share.conf",
    configRoot: "/etc/nginx",
    serverName: "x`uname`y.example",
  })).toThrow();
});

test("a plaintext listener beside the TLS one is refused", () => {
  const sh = buildApplyScript({
    snippet: "location /magpie/ { }",
    snippetPath: "/etc/nginx/snippets/magpie-share.conf",
    configRoot: "/etc/nginx",
    serverName: "us.cyanai.eu.cc",
  });
  expect(sh).toContain("grep -Evq '443|ssl'");
  expect(sh).toContain("MAGPIE:NOT_TLS");
});

test("a file with several server blocks applies when one names the host", () => {
  const sites = `server {
    listen 127.0.0.1:10443 ssl;
    server_name other.example;
    ssl_certificate /tmp/other.pem;
    location / { return 404; }
}
server {
    listen 127.0.0.1:10443 ssl;
    server_name magpie.example;
    ssl_certificate /tmp/site.pem;
    location / { return 404; }
}
`;
  const run = runApply(sites);
  try {
    expect(run.stdout).toContain("MAGPIE:OK");
    expect(run.status).toBe(0);
    expect(run.text).toContain(`server_name magpie.example;\n    include ${run.snippetPath};`);
    expect(run.text).toContain("server_name other.example;");
    expect(existsSync(run.snippetPath)).toBe(true);
  } finally {
    run.cleanup();
  }
});

test("applying the same snippet twice is idempotent", () => {
  const sites = `server {
    listen 127.0.0.1:10443 ssl;
    server_name magpie.example;
    ssl_certificate /tmp/site.pem;
    location / { return 404; }
}
`;
  const run = runApply(sites);
  try {
    expect(run.status).toBe(0);
    const again = run.applyAgain();
    expect(again.stdout).toContain("MAGPIE:OK");
    expect(again.status).toBe(0);
    const includes = again.text.split(/\r?\n/).filter((line) => line.includes("include ") && line.includes("magpie-share.conf"));
    expect(includes.length).toBe(1);
  } finally {
    run.cleanup();
  }
});

test("backup copies beside the config are not mistaken for live sites", () => {
  const sites = `server {
    listen 127.0.0.1:10443 ssl;
    server_name magpie.example;
    ssl_certificate /tmp/site.pem;
    location / { return 404; }
}
`;
  const run = runApply(sites, "magpie.example", {
    "sites/sites.conf.bak-20260101": sites,
  });
  try {
    expect(run.stdout).toContain("MAGPIE:OK");
    expect(run.status).toBe(0);
    expect(run.text).toContain(`server_name magpie.example;\n    include ${run.snippetPath};`);
  } finally {
    run.cleanup();
  }
});

test("two server_name lines for the same host are refused", () => {
  const sites = `server {
    listen 127.0.0.1:10443 ssl;
    server_name magpie.example;
    ssl_certificate /tmp/site.pem;
}
server {
    listen 127.0.0.1:10443 ssl;
    server_name magpie.example;
    ssl_certificate /tmp/site.pem;
}
`;
  const run = runApply(sites);
  try {
    expect(run.status).toBe(11);
    expect(run.stdout).toContain("MAGPIE:NO_SERVER");
  } finally {
    run.cleanup();
  }
});

test("the generated script parses as POSIX sh", () => {
  const script = buildApplyScript({
    snippet: "location /magpie/ { proxy_pass http://127.0.0.1:13425/; }",
    snippetPath: "/etc/nginx/snippets/magpie-share.conf",
    configRoot: "/etc/nginx",
    serverName: "us.cyanai.eu.cc",
  });
  const result = Bun.spawnSync({
    cmd: ["sh", "-n"],
    stdin: new TextEncoder().encode(script),
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
});
