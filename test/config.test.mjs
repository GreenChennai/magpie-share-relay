import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPaths, loadConfig, normalizeConfig, saveConfig } from "../lib/config.mjs";

const fresh = () => configPaths({ XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "share-relay-")) });

test("first run writes defaults with sharing off", async () => {
  const paths = fresh();
  const cfg = await loadConfig(paths);
  expect(cfg.enabled).toBe(false);
  expect(cfg.autoStart).toBe(true);
  expect(cfg.remotePort).toBe(13425);
  expect(cfg.publicURL).toBe("https://us.cyanai.eu.cc/magpie");
  expect(JSON.parse(readFileSync(paths.configPath, "utf8")).enabled).toBe(false);
});

test("save keeps the previous config as .bak and leaves no temp file", async () => {
  const paths = fresh();
  const cfg = await loadConfig(paths);
  cfg.ssh.host = "rn.example.com";
  await saveConfig(paths, cfg);
  expect(JSON.parse(readFileSync(paths.backupPath, "utf8")).ssh.host).toBe("us.cyanai.eu.cc");
  expect(JSON.parse(readFileSync(paths.configPath, "utf8")).ssh.host).toBe("rn.example.com");
  expect(existsSync(paths.configPath + ".tmp." + process.pid)).toBe(false);
});

test("a broken config falls back to the backup", async () => {
  const paths = fresh();
  const cfg = await loadConfig(paths);
  await saveConfig(paths, { ...cfg, ssh: { ...cfg.ssh, user: "ubuntu" } });
  writeFileSync(paths.configPath, "{ not json", "utf8");
  const back = await loadConfig(paths);
  expect(back.ssh.user).toBe("root");
  expect(back.recoveredFromBackup).toBe(true);
});

test("saving after a corrupt config keeps the good backup", async () => {
  const paths = fresh();
  const cfg = await loadConfig(paths);
  await saveConfig(paths, { ...cfg, ssh: { ...cfg.ssh, user: "ubuntu" } });
  await saveConfig(paths, { ...cfg, ssh: { ...cfg.ssh, user: "debian" } });
  writeFileSync(paths.configPath, "{ not json", "utf8");
  const back = await loadConfig(paths);
  back.ssh.host = "rn.example.com";
  await saveConfig(paths, back);
  expect(JSON.parse(readFileSync(paths.backupPath, "utf8")).ssh.user).toBe("ubuntu");
  const corrupt = readdirSync(paths.dataDir).filter((name) => name.startsWith("config.json.corrupt."));
  expect(corrupt.length).toBe(1);
});

test("a publicURL whose host is not a DNS name is refused", () => {
  expect(() => normalizeConfig({ publicURL: "https://x%60uname%60.example/magpie" })).toThrow();
  expect(() => normalizeConfig({ publicURL: "https://x%22y.example/magpie" })).toThrow();
  expect(normalizeConfig({ publicURL: "https://us.cyanai.eu.cc/magpie" }).publicURL)
    .toBe("https://us.cyanai.eu.cc/magpie");
});

test("an explicit ssh binary is kept", () => {
  const cfg = normalizeConfig({ ssh: { bin: "D:\\Tools\\ssh.exe" } });
  expect(cfg.ssh.bin).toBe("D:\\Tools\\ssh.exe");
  expect(() => normalizeConfig({ ssh: { bin: 42 } })).toThrow();
});
