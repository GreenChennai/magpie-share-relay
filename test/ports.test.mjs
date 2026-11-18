import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredPort, startupDelay } from "../lib/ports.mjs";

test("exact, versioned and path specs find this plugin's port", () => {
  const root = mkdtempSync(join(tmpdir(), "share-relay-"));
  const pkgRoot = join(root, "plugin");
  mkdirSync(pkgRoot);
  writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: "magpie-share-relay" }));
  const pluginsPath = join(root, "plugins.json");
  const opts = { pluginsPath, packageName: "magpie-share-relay", packageRoot: pkgRoot };

  writeFileSync(pluginsPath, JSON.stringify({ plugins: [{ spec: "magpie-share-relay", options: { port: 3498 } }] }));
  expect(configuredPort(opts)).toBe(3498);
  writeFileSync(pluginsPath, JSON.stringify({ plugins: [{ spec: "magpie-share-relay@0.1.0", options: { port: 3499 } }] }));
  expect(configuredPort(opts)).toBe(3499);

  writeFileSync(pluginsPath, JSON.stringify({ plugins: [{ spec: pkgRoot, options: { port: 3500 } }] }));
  expect(configuredPort(opts)).toBe(3500);

  writeFileSync(pluginsPath, JSON.stringify({ plugins: [] }));
  expect(configuredPort(opts)).toBe(3488);
});

test("a moved service port waits 30s before taking the lock", () => {
  expect(startupDelay(3488, 3488)).toBe(0);
  expect(startupDelay(41000, 3488)).toBe(30000);
});
