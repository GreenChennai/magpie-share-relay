// Both links are the same public base and the same key; only the client
// shape differs. Nothing here ever embeds a real secret.

export function normalizeBase(publicURL) {
  let url;
  try {
    url = new URL(String(publicURL || ""));
  } catch {
    throw new Error("publicURL must be a full https URL");
  }
  if (url.protocol !== "https:") throw new Error("publicURL must use https");
  const path = url.pathname.replace(/\/+$/, "");
  if (!path || path === "/") {
    throw new Error("publicURL must have a path prefix such as /magpie, not /");
  }
  return `${url.origin}${path}`;
}

export function buildLinks(publicURL) {
  const base = normalizeBase(publicURL);
  return {
    base,
    openaiBase: `${base}/v1`,
    anthropicBase: base,
    geminiBase: base,
    remoteMagpie: base,
  };
}

export function claudeCodeEnv(base) {
  return [
    `export ANTHROPIC_BASE_URL=${base}`,
    "export ANTHROPIC_AUTH_TOKEN=<key>",
    "export ANTHROPIC_MODEL=<model id>",
  ].join("\n");
}

export function curlExample(base) {
  return `curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer <key>" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"<model id>","messages":[{"role":"user","content":"你好"}]}'`;
}

export function remoteMagpieCommand(base, id) {
  const slug = String(id || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "friend";
  const shareId = slug.endsWith("-share") ? slug : `${slug}-share`;
  return `magpie provider add remote-magpie <key> url=${base} id=${shareId}`;
}
