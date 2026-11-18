import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("the UI has the sections the plan draws", () => {
  const html = readFileSync(join(import.meta.dir, "..", "ui", "index.html"), "utf8");
  for (const id of ["status", "setup", "friends", "links", "logs", "diagnose"]) {
    expect(html).toContain(`id="${id}"`);
  }
  const js = readFileSync(join(import.meta.dir, "..", "ui", "app.js"), "utf8");
  expect(js).toContain("x-magpie-share-token");
  expect(js).toContain("/api/state");
});

test("the page never calls modal APIs the sandbox blocks", () => {
  const js = readFileSync(join(import.meta.dir, "..", "ui", "app.js"), "utf8");
  expect(js).not.toMatch(/\b(?:confirm|alert|prompt)\s*\(/);
});

test("the page shows reconnect attempts and warns about interrupted streams", () => {
  const js = readFileSync(join(import.meta.dir, "..", "ui", "app.js"), "utf8");
  const html = readFileSync(join(import.meta.dir, "..", "ui", "index.html"), "utf8");
  expect(js).toContain("attempts");
  expect(html).toContain("重连会中断");
});
