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

test("setup folds away and the endpoint URLs show without a friend", () => {
  const html = readFileSync(join(import.meta.dir, "..", "ui", "index.html"), "utf8");
  const js = readFileSync(join(import.meta.dir, "..", "ui", "app.js"), "utf8");
  expect(html).toMatch(/<details[^>]*id="setup"/);
  expect(html.indexOf('id="links-endpoints"')).toBeGreaterThan(-1);
  expect(html.indexOf('id="links-endpoints"')).toBeLessThan(html.indexOf('id="links-content"'));
  expect(js).toMatch(/\$\("setup"\)\.open\s*=/);
});

test("the endpoint URLs are filled in before the no-friend guard", () => {
  const js = readFileSync(join(import.meta.dir, "..", "ui", "app.js"), "utf8");
  const start = js.indexOf("function renderLinks()");
  const end = js.indexOf("function renderLogs()");
  const render = js.slice(start, end);
  expect(start).toBeGreaterThan(-1);
  expect(render.indexOf('$("link-openai").textContent')).toBeGreaterThan(-1);
  expect(render.indexOf('$("link-openai").textContent')).toBeLessThan(render.indexOf("if (!invite"));
});

test("creating a friend does not rely on native form submission", () => {
  const html = readFileSync(join(import.meta.dir, "..", "ui", "index.html"), "utf8");
  const js = readFileSync(join(import.meta.dir, "..", "ui", "app.js"), "utf8");
  expect(html).not.toContain("<form");
  expect(html).toContain('id="create-friend"');
  expect(js).not.toContain('addEventListener("submit"');
  expect(js).toContain('$("create-friend")');
});
