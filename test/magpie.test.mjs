import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseKeyList, parseSecret, createMagpie, findMagpie, maskSecret } from "../lib/magpie.mjs";

const table = `ID                        NAME             STATE    GATEWAY KEY            LIMIT  MODELS  ACCOUNTS  ACCESS
3229851908b3f48f1b68924e  share-alice-7f3a enabled  masked-key-a3c1  -      all     all       full
3229851908b3f48f1b68924f  share-bob-1a2b   enabled  masked-key-b4d2  -      all     all       full
`;

test("the first two columns survive states and limits with spaces", () => {
  const rows = parseKeyList(table);
  expect(rows[0]).toMatchObject({ id: "3229851908b3f48f1b68924e", name: "share-alice-7f3a" });
  expect(rows[1].name).toBe("share-bob-1a2b");
  expect(rows[0].state).toBe("enabled");
});

test("limit off then a new day limit are two commands", async () => {
  const calls = [];
  const magpie = createMagpie({
    bin: "magpie",
    run: async (argv) => {
      calls.push(argv);
      if (argv[1] === "add") return { code: 0, stdout: "sk-magpie-test-1234\n", stderr: "" };
      if (argv[1] === "list") return { code: 0, stdout: table, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await magpie.limit("3229851908b3f48f1b68924e", { period: "day", costUsd: 5 });
  expect(calls[0]).toEqual(["magpie", "gateway-key", "limit", "3229851908b3f48f1b68924e", "off"]);
  expect(calls[1]).toEqual(["magpie", "gateway-key", "limit", "3229851908b3f48f1b68924e", "day", "--cost", "5"]);
});

test("a secret is masked to its last four", () => {
  expect(maskSecret("test-secret-1234")).toBe("****1234");
  expect(maskSecret("short")).toBe("****");
});

test("a secret is the last bare line, never a warning", () => {
  const secret = "sk-magpie-test-1234";
  expect(parseSecret(`warning: something\n${secret}\n`)).toBe(secret);
  expect(() => parseSecret("warning: only a warning\n")).toThrow();
  expect(() => parseSecret("")).toThrow();
});

test("add, list and rotate parse their own output", async () => {
  const added = "sk-magpie-test-1234";
  const rotated = "test-secret-1234";
  const magpie = createMagpie({
    bin: "magpie",
    run: async (argv) => {
      if (argv[2] === "add") return { code: 0, stdout: `creating...\n${added}\n`, stderr: "" };
      if (argv[2] === "list") return { code: 0, stdout: table, stderr: "" };
      if (argv[2] === "rotate") return { code: 0, stdout: `${rotated}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  expect(await magpie.add("share-alice-7f3a")).toBe(added);
  expect((await magpie.list())[0].id).toBe("3229851908b3f48f1b68924e");
  expect(await magpie.rotate("3229851908b3f48f1b68924e")).toBe(rotated);
});

test("a failed command never echoes its stdout", async () => {
  const secret = "test-secret-1234";
  const magpie = createMagpie({
    bin: "magpie",
    run: async (argv) => {
      if (argv[2] === "add") return { code: 1, stdout: `${secret}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  let message = "";
  try {
    await magpie.add("x");
  } catch (err) {
    message = String(err?.message || err);
  }
  expect(message).toContain("exit 1");
  expect(message).not.toContain(secret);
});

test("findMagpie trusts a working configured path and falls back to PATH", async () => {
  const calls = [];
  const run = async (argv) => {
    calls.push(argv);
    if (argv[0] === "C:\\Agent\\Magpie\\magpie.com") return { code: 0, stdout: "", stderr: "" };
    if (argv[0] === "magpie") return { code: 1, stdout: "", stderr: "not found" };
    if (argv[0] === "where.exe") return { code: 0, stdout: "C:\\Other\\magpie.exe\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };
  expect(await findMagpie({ configured: "C:\\Agent\\Magpie\\magpie.com", ppid: 0, run, platform: "win32" }))
    .toBe("C:\\Agent\\Magpie\\magpie.com");

  const fallback = await findMagpie({ configured: "", ppid: 0, run, platform: "linux" });
  expect(fallback).toBe("magpie");
});

test("findMagpie prefers the .com shim beside a parent .exe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "magpie-bin-"));
  const exe = join(dir, "magpie.exe");
  const com = join(dir, "magpie.com");
  writeFileSync(exe, "");
  writeFileSync(com, "");
  const run = async (argv) => {
    if (argv[0] === "powershell") return { code: 0, stdout: exe + "\n", stderr: "" };
    if (argv[0] === com) return { code: 0, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };
  expect(await findMagpie({ configured: "", ppid: 1234, run, platform: "win32" })).toBe(com);
});
