import { test, expect } from "bun:test";
import { candidateIPs, selectLanIP } from "../lib/lanip.mjs";

const interfaces = {
  Clash: [{ family: "IPv4", address: "198.18.0.1", internal: false }],
  "ZeroTier One": [{ family: "IPv4", address: "172.26.202.51", internal: false }],
  WLAN: [{ family: "IPv4", address: "192.168.66.6", internal: false }],
  Ethernet: [{ family: "IPv4", address: "10.0.0.5", internal: false }],
  Loopback: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
};

test("Clash, ZeroTier and loopback are never candidates", () => {
  expect(candidateIPs(interfaces)).toEqual(["192.168.66.6", "10.0.0.5"]);
});

test("a 401 wins, a 200 is refused even on a private address", async () => {
  const probe = async (ip) => ({ status: ip === "192.168.66.6" ? 401 : 200 });
  const r = await selectLanIP({ interfaces, port: 3425, probe });
  expect(r.ip).toBe("192.168.66.6");
  expect(r.results.find((x) => x.ip === "10.0.0.5").accepted).toBe(false);
});

test("the same IP can be rejected when it answers 200", async () => {
  const probe = async (ip) => ({ status: ip === "192.168.66.6" ? 200 : 401 });
  const r = await selectLanIP({ interfaces, port: 3425, probe });
  expect(r.ip).toBe("10.0.0.5");
});
