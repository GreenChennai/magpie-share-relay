import { test, expect } from "bun:test";
import { buildLinks, claudeCodeEnv, curlExample, remoteMagpieCommand } from "../lib/links.mjs";

test("one base, two shapes", () => {
  const l = buildLinks("https://us.cyanai.eu.cc/magpie/");
  expect(l.base).toBe("https://us.cyanai.eu.cc/magpie");
  expect(l.openaiBase).toBe("https://us.cyanai.eu.cc/magpie/v1");
  expect(l.anthropicBase).toBe("https://us.cyanai.eu.cc/magpie");
  expect(l.geminiBase).toBe("https://us.cyanai.eu.cc/magpie");
  expect(l.remoteMagpie).toBe("https://us.cyanai.eu.cc/magpie");
});

test("the instructions carry placeholders, never a secret", () => {
  const env = claudeCodeEnv("https://us.cyanai.eu.cc/magpie");
  expect(env).toContain("ANTHROPIC_BASE_URL=https://us.cyanai.eu.cc/magpie");
  expect(env).toContain("ANTHROPIC_AUTH_TOKEN=<key>");
  expect(remoteMagpieCommand("https://us.cyanai.eu.cc/magpie", "alice"))
    .toBe("magpie provider add remote-magpie <key> url=https://us.cyanai.eu.cc/magpie id=alice-share");
});

test("the curl example points at /v1 with placeholders", () => {
  const curl = curlExample("https://us.cyanai.eu.cc/magpie");
  expect(curl).toContain("https://us.cyanai.eu.cc/magpie/v1/chat/completions");
  expect(curl).toContain("Authorization: Bearer <key>");
  expect(curl).toContain("<model id>");
});

test("a root or plain-http base is refused", () => {
  expect(() => buildLinks("https://us.cyanai.eu.cc/")).toThrow();
  expect(() => buildLinks("http://us.cyanai.eu.cc/magpie")).toThrow();
});
