import os from "node:os";

const VIRTUAL = /zerotier|tailscale|clash|mihomo|wintun|tun|tap|wsl|vethernet|docker|vmware|virtualbox|hyper-v|npcap/i;
const PREFERRED = /wlan|wi-?fi|ethernet/i;

function isIPv4(entry) {
  return entry?.family === "IPv4" || entry?.family === 4;
}

function excluded(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function classRank(address) {
  const [a, b] = address.split(".").map(Number);
  if (a === 192 && b === 168) return 0;
  if (a === 10) return 1;
  if (a === 172 && b >= 16 && b <= 31) return 2;
  return 3;
}

export function candidateIPs(interfaces = os.networkInterfaces()) {
  const found = [];
  for (const [name, entries] of Object.entries(interfaces || {})) {
    if (!entries || VIRTUAL.test(name)) continue;
    for (const entry of entries) {
      if (!isIPv4(entry) || entry.internal) continue;
      const address = String(entry.address || "");
      if (excluded(address)) continue;
      found.push({
        address,
        preferred: PREFERRED.test(name) ? 0 : 1,
        rank: classRank(address),
      });
    }
  }
  const seen = new Set();
  return found
    .sort((a, b) => a.preferred - b.preferred || a.rank - b.rank || a.address.localeCompare(b.address))
    .map((entry) => entry.address)
    .filter((address) => {
      if (seen.has(address)) return false;
      seen.add(address);
      return true;
    });
}

// selectLanIP probes every candidate: a 401/403 means the gateway asked
// for a key, while a 200 means the tunnel would expose it without one.
export async function selectLanIP({ interfaces = os.networkInterfaces(), port, probe, fixed = "" }) {
  const candidates = fixed ? [fixed] : candidateIPs(interfaces);
  const results = [];
  let chosen = "";

  for (const ip of candidates) {
    let answer;
    try {
      answer = await probe(ip, port);
    } catch (err) {
      answer = { status: 0, error: String(err?.message || err) };
    }
    const status = Number(answer?.status) || 0;
    let accepted = false;
    let reason = "";
    if (status === 401 || status === 403) {
      accepted = true;
    } else if (status === 200) {
      reason = "gateway answered without a key";
    } else if (answer?.error) {
      reason = answer.error;
    } else {
      reason = `gateway answered ${status || "nothing"}`;
    }
    results.push({ ip, status, accepted, reason });
    if (accepted && !chosen) chosen = ip;
  }

  return { ip: chosen, candidates, results };
}
