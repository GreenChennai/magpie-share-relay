import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

export const TOKEN_HEADER = "x-magpie-share-token";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const BODY_LIMIT = 1 << 20;

function hasHeader(headers, name) {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

export function createServiceServer({ port = 3488, uiRoot, token = randomBytes(32).toString("hex"), handle }) {
  let actualPort = port;
  let own = new Set();
  let hosts = new Set();

  function setOwn(p) {
    actualPort = p;
    own = new Set([`http://127.0.0.1:${p}`, `http://localhost:${p}`]);
    hosts = new Set([`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`]);
  }

  function originAllowed(req) {
    const origin = req.headers.origin;
    return origin === undefined || origin === "null" || own.has(origin);
  }

  function hostAllowed(req) {
    return hosts.has(String(req.headers.host || "").toLowerCase());
  }

  function tokenOK(req) {
    const got = Buffer.from(String(req.headers[TOKEN_HEADER] || ""));
    const want = Buffer.from(token);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  function corsHeaders(req) {
    const origin = req.headers.origin;
    const allow = origin === "null" ? "null" : origin && own.has(origin) ? origin : "null";
    return {
      "access-control-allow-origin": allow,
      "access-control-allow-headers": "content-type, " + TOKEN_HEADER,
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      vary: "Origin",
    };
  }

  function send(res, status, body, headers = {}, cors = true) {
    const out = { ...headers };
    let data;
    if (typeof body === "string" || body instanceof Uint8Array) {
      data = body;
      if (!hasHeader(out, "content-type")) out["content-type"] = "text/plain; charset=utf-8";
    } else if (body === undefined) {
      data = "";
    } else {
      data = JSON.stringify(body);
      if (!hasHeader(out, "content-type")) out["content-type"] = "application/json; charset=utf-8";
    }
    if (!hasHeader(out, "cache-control")) out["cache-control"] = "no-store";
    out["x-content-type-options"] = "nosniff";
    if (cors) Object.assign(out, corsHeaders(res.req));
    res.writeHead(status, out);
    res.end(data);
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        const err = new Error("request body is larger than 1 MiB");
        err.status = 413;
        throw err;
      }
      chunks.push(chunk);
    }
    if (!chunks.length) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      const err = new Error("request body is not valid JSON");
      err.status = 400;
      throw err;
    }
  }

  async function serveStatic(req, res, path) {
    let decoded;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return send(res, 400, { error: "bad path" });
    }
    const root = resolve(uiRoot);
    const rel = decoded.replace(/^[/\\]+/, "");
    const file = resolve(root, rel || "index.html");
    if (!file.startsWith(root + sep)) return send(res, 403, { error: "forbidden" }, {}, false);
    const data = await readFile(file).catch(() => null);
    if (!data) return send(res, 404, "not found", { "content-type": MIME[".html"] }, false);
    if (file === join(root, "index.html")) {
      const meta = `<meta name="magpie-share-token" content="${token.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}">`;
      const html = data.toString("utf8");
      const injected = html.includes("<head>") ? html.replace("<head>", `<head>\n${meta}`) : meta + html;
      return send(res, 200, injected, { "content-type": MIME[".html"] }, false);
    }
    return send(res, 200, data, { "content-type": MIME[extname(file).toLowerCase()] || "application/octet-stream" });
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const path = url.pathname;
      if (!hostAllowed(req)) return send(res, 403, { error: "this service only answers its own host" }, {}, false);
      if (!originAllowed(req)) return send(res, 403, { error: "this service only answers magpie's page" });
      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders(req));
        return res.end();
      }
      if (path === "/api/ping") {
        return send(res, 200, { ok: true, service: "magpie-share-relay" });
      }
      if (path.startsWith("/api/")) {
        if (!tokenOK(req)) {
          return send(res, 403, { error: "bad or missing token; reload the page", reload: true });
        }
        const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
        const query = Object.fromEntries(url.searchParams);
        const out = await handle({ method: req.method, path, query, body });
        return send(res, out.status ?? 200, out.body, out.headers);
      }
      return await serveStatic(req, res, path);
    } catch (err) {
      if (res.headersSent) {
        try { res.end(); } catch { /* already ended */ }
        return;
      }
      return send(res, err.status || 500, { error: String(err?.message || err) });
    }
  });

  return {
    port,
    token,
    listen() {
      return new Promise((resolveListen, reject) => {
        const onError = (err) => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          const address = server.address();
          setOwn(address && typeof address === "object" ? address.port : actualPort);
          resolveListen(actualPort);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(actualPort, "127.0.0.1");
      });
    },
    close() {
      if (!server.listening) return Promise.resolve();
      return new Promise((resolveClose, reject) => {
        server.close((err) => (err ? reject(err) : resolveClose()));
      });
    },
  };
}
