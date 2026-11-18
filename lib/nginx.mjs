// The RN side of the relay: one nginx snippet under the public path, applied
// with a backup, an nginx -t and an automatic rollback. Nothing here guesses
// which server block to edit; a host with more than one candidate is refused.

const TRIM_SLASHES = /\/+$/;

export function publicPath(publicURL) {
  let url;
  try {
    url = new URL(String(publicURL || ""));
  } catch {
    throw new Error("publicURL must be a full https URL");
  }
  if (url.protocol !== "https:") throw new Error("publicURL must use https");
  if (!/^\/[A-Za-z0-9._~-]+\/?$/.test(url.pathname)) {
    throw new Error("publicURL must have a path prefix such as /magpie, not /");
  }
  return url.pathname.replace(TRIM_SLASHES, "");
}

export function includeLine(snippetPath) {
  return `    include ${snippetPath};`;
}

// The hostname ends up inside a double-quoted shell argument in the apply
// script. Percent-encoded characters such as %60 are decoded by URL, so a
// plain DNS-name check is the only safe boundary.
export function serverNameOf(publicURL) {
  let url;
  try {
    url = new URL(String(publicURL || ""));
  } catch {
    throw new Error("publicURL must be a full https URL");
  }
  const host = url.hostname;
  if (!/^[A-Za-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".") || host.includes("..")) {
    throw new Error("publicURL hostname must be a plain DNS name");
  }
  return host;
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function renderSnippet({ publicURL, remotePort }) {
  const prefix = publicPath(publicURL);
  const port = Number(remotePort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("remotePort must be a port number");
  }
  const re = regexEscape(prefix);
  return `# Managed by magpie-share-relay. Edits here are overwritten by the plugin.
# Deny the host-only APIs even if a key leaks.
location ~ ^${re}/v1/magpie/(admin|usage)(/|$) {
    return 403;
}

# magpie's own page assets are not part of the shared API.
location ~ ^${re}/_magpie(/|$) {
    return 404;
}

location = ${prefix} {
    return 301 ${prefix}/;
}

location ${prefix}/ {
    proxy_pass http://127.0.0.1:${port}/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # SSE and long generations
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    client_max_body_size 100m;
}
`;
}

export function findConflict(nginxT, prefix, snippetPath) {
  const lines = [];
  let currentFile = "";
  for (const raw of String(nginxT || "").split(/\r?\n/)) {
    const header = /^# configuration file (.+):$/.exec(raw.trim());
    if (header) {
      currentFile = header[1];
      continue;
    }
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!/\blocation\b/.test(line)) continue;

    const index = line.indexOf(prefix);
    if (index === -1) continue;
    const after = line[index + prefix.length];
    if (after !== undefined && after !== "/" && !/\s/.test(after)) continue;
    if (snippetPath && currentFile === snippetPath) continue;
    lines.push(raw);
  }
  return { found: lines.length > 0, lines };
}

function prefixFromSnippet(snippet) {
  const exact = /\blocation\s*=\s*(\/[^\s{]*)/.exec(snippet);
  if (exact) return exact[1].replace(TRIM_SLASHES, "");
  const plain = /\blocation\s+(?![~^=])(\/[^\s{]*)/.exec(snippet);
  if (plain) return plain[1].replace(TRIM_SLASHES, "");
  return "";
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

export function buildApplyScript({
  snippet,
  snippetPath,
  configRoot,
  serverName,
  sudo = "auto",
}) {
  const text = String(snippet || "");
  if (!text.trim()) throw new Error("the snippet is empty");
  if (text.includes("MAGPIE_SNIPPET")) {
    throw new Error("the snippet contains the heredoc terminator MAGPIE_SNIPPET");
  }
  if (!serverName) throw new Error("serverName is required");
  if (!/^[A-Za-z0-9.-]+$/.test(String(serverName))) {
    throw new Error("serverName must be a plain DNS name");
  }
  const prefix = prefixFromSnippet(text);
  if (!prefix) throw new Error("the snippet has no location path");

  const qSnippet = shellQuote(snippetPath);
  const qRoot = shellQuote(configRoot);
  const qPrefix = shellQuote(prefix);
  const prefixRe = regexEscape(prefix);
  const qInclude = shellQuote(includeLine(snippetPath));
  const serverRe = regexEscape(serverName);

  return `set -eu
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if ! sudo -n true 2>/dev/null; then
    echo "MAGPIE:SUDO"
    exit 13
  fi
  SUDO="sudo -n"
fi

ROOT=${qRoot}
SNIPPET=${qSnippet}
PREFIX=${qPrefix}
INCLUDE=${qInclude}
SNIPPET_REAL=$(readlink -f "$SNIPPET" 2>/dev/null || printf '%s' "$SNIPPET")

OTHER=$(grep -Rls --exclude='*.bak*' --exclude='*.tmp' -E '^[[:space:]]*location' "$ROOT" 2>/dev/null | while IFS= read -r f; do
  real=$(readlink -f "$f" 2>/dev/null || printf '%s' "$f")
  if [ "$real" = "$SNIPPET_REAL" ]; then continue; fi
  if grep -Eq "^[[:space:]]*location[^#]*${prefixRe}([[:space:]{/]|$)" "$f"; then printf '%s\\n' "$f"; fi
done | head -n 1)
if [ -n "$OTHER" ]; then
  echo "MAGPIE:CONFLICT $OTHER"
  exit 11
fi

FILES=$($SUDO nginx -T 2>/dev/null | sed -n 's/^# configuration file \\(.*\\):$/\\1/p' | while IFS= read -r f; do
  real=$(readlink -f "$f" 2>/dev/null || printf '%s' "$f")
  if grep -Eq "server_name[^;]*${serverRe}" "$real" 2>/dev/null; then printf '%s\\n' "$real"; fi
done | sort -u)
COUNT=$(printf '%s\\n' "$FILES" | grep -c . || true)
if [ "$COUNT" -ne 1 ]; then
  echo "MAGPIE:NO_SERVER"
  exit 11
fi
FILE=$(printf '%s\\n' "$FILES")

if ! grep -Eq 'listen[^;]*[ :]443|ssl_certificate[[:space:]]' "$FILE"; then
  echo "MAGPIE:NOT_TLS"
  exit 10
fi

LISTENS=$(grep -E '^[[:space:]]*listen[[:space:]]+[^;]*;' "$FILE" || true)
if [ -n "$LISTENS" ] && printf '%s\n' "$LISTENS" | grep -Evq '443|ssl'; then
  echo "MAGPIE:NOT_TLS"
  exit 10
fi

MATCHES=$(grep -Ec "server_name[^;]*${serverRe}" "$FILE" || true)
if [ "$MATCHES" -ne 1 ]; then
  echo "MAGPIE:NO_SERVER"
  exit 11
fi

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BAK="$FILE.bak.$STAMP"
$SUDO cp -a "$FILE" "$BAK"
SNIP_BAK=""
if [ -f "$SNIPPET" ]; then
  SNIP_BAK="$SNIPPET.bak.$STAMP"
  $SUDO cp -a "$SNIPPET" "$SNIP_BAK"
fi

$SUDO mkdir -p "$(dirname "$SNIPPET")"
$SUDO tee "$SNIPPET" >/dev/null <<'MAGPIE_SNIPPET'
${text.replace(/\n$/, "")}
MAGPIE_SNIPPET

if ! grep -qF -- "$INCLUDE" "$FILE"; then
  $SUDO sed -i "/server_name[^;]*${serverRe}/s|$|\\n$INCLUDE|" "$FILE"
fi

if ! $SUDO nginx -t; then
  $SUDO cp -a "$BAK" "$FILE"
  if [ -n "$SNIP_BAK" ]; then
    $SUDO cp -a "$SNIP_BAK" "$SNIPPET"
  else
    $SUDO rm -f "$SNIPPET"
  fi
  $SUDO nginx -t || true
  echo "MAGPIE:NGINX_TEST_FAILED"
  exit 12
fi

if command -v systemctl >/dev/null 2>&1; then
  if ! $SUDO systemctl reload nginx; then
    echo "MAGPIE:RELOAD_FAILED"
    exit 14
  fi
else
  if ! $SUDO nginx -s reload; then
    echo "MAGPIE:RELOAD_FAILED"
    exit 14
  fi
fi

echo "MAGPIE:OK $FILE $SNIPPET $STAMP"
`;
}

const RESULTS = {
  OK: { ok: true, code: "ok", message: "nginx updated and reloaded" },
  CONFLICT: { ok: false, code: "conflict", message: "another location already uses this prefix" },
  NO_SERVER: { ok: false, code: "no_server", message: "could not find exactly one TLS server block for the host" },
  NOT_TLS: { ok: false, code: "not_tls", message: "the server block for the host is not HTTPS" },
  NGINX_TEST_FAILED: { ok: false, code: "nginx_test_failed", message: "nginx -t failed; the previous config was restored" },
  SUDO: { ok: false, code: "sudo", message: "sudo needs a password on the server; run the script manually" },
  RELOAD_FAILED: { ok: false, code: "reload_failed", message: "nginx -t passed but the reload failed" },
};

export async function applyNginx({ config, runRemote, log }) {
  const nginx = config.nginx || {};
  const snippetPath = nginx.snippetPath || "/etc/nginx/snippets/magpie-share.conf";
  const configRoot = nginx.configRoot || "/etc/nginx";
  let serverName;
  try {
    serverName = serverNameOf(config.publicURL);
  } catch (err) {
    return { ok: false, code: "public_url", message: String(err?.message || err) };
  }

  let snippet;
  let prefix;
  try {
    prefix = publicPath(config.publicURL);
    snippet = renderSnippet({ publicURL: config.publicURL, remotePort: config.remotePort });
  } catch (err) {
    return { ok: false, code: "public_url", message: String(err?.message || err) };
  }

  const probe = await runRemote("nginx -T", 20000);
  if (probe.code !== 0) {
    log?.event?.("nginx", "nginx -T failed", { exit: probe.code });
    return {
      ok: false,
      code: "nginx_t_failed",
      message: "nginx -T failed on the server",
      detail: `${probe.stdout || ""}\n${probe.stderr || ""}`.trim(),
    };
  }

  const conflict = findConflict(probe.stdout, prefix, snippetPath);
  if (conflict.found) {
    log?.event?.("nginx", "location conflict", { prefix, lines: conflict.lines });
    return {
      ok: false,
      code: "conflict",
      message: `another nginx location already uses ${prefix}`,
      detail: conflict.lines.join("\n"),
    };
  }

  let script;
  try {
    script = buildApplyScript({
      snippet,
      snippetPath,
      configRoot,
      serverName,
      sudo: config.ssh?.sudo || "auto",
    });
  } catch (err) {
    return { ok: false, code: "script", message: String(err?.message || err) };
  }

  const result = await runRemote(script, 60000);
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const match = /MAGPIE:([A-Z_]+)/.exec(output);
  const tag = match ? match[1] : result.code === 0 ? "OK" : "FAILED";
  const mapped = RESULTS[tag] || { ok: false, code: "failed", message: "the apply script failed" };
  log?.event?.("nginx", mapped.message, { tag, exit: result.code });
  if (mapped.ok) {
    const appliedAt = new Date().toISOString();
    config.nginx = { ...nginx, lastAppliedAt: appliedAt };
    return { ...mapped, appliedAt, detail: output.trim() };
  }
  return { ...mapped, detail: output.trim() };
}
