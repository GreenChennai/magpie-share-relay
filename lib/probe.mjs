import http from "node:http";
import https from "node:https";

// getJSON never uses fetch: a system proxy (Clash and friends) would send
// a probe of this computer's own LAN address somewhere else.
export function getJSON(url, { headers = {}, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      resolve({ status: 0, json: null, error: String(err?.message || err) });
      return;
    }
    const lib = target.protocol === "https:" ? https : target.protocol === "http:" ? http : null;
    if (!lib) {
      resolve({ status: 0, json: null, error: `unsupported protocol ${target.protocol}` });
      return;
    }

    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = lib.request(target, {
      method: "GET",
      headers: { accept: "application/json", ...headers },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (body.length < (1 << 20)) body += chunk.slice(0, (1 << 20) - body.length);
      });
      res.on("end", () => {
        let json = null;
        try {
          json = body ? JSON.parse(body) : null;
        } catch {
          json = null;
        }
        done({ status: res.statusCode || 0, json, error: "" });
      });
      res.on("error", (err) => done({ status: res.statusCode || 0, json: null, error: String(err?.message || err) }));
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", (err) => done({ status: 0, json: null, error: String(err?.message || err) }));
    req.end();
  });
}
