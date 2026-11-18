import { test, expect } from "bun:test";
import { publicPath, renderSnippet, findConflict, buildApplyScript, serverNameOf } from "../lib/nginx.mjs";

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
