import { test, expect } from "bun:test";
import { runCommand } from "../lib/exec.mjs";

test("runCommand captures stdout, stderr and the exit code", async () => {
  const r = await runCommand([
    process.execPath,
    "-e",
    "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)",
  ]);
  expect(r.code).toBe(3);
  expect(r.stdout).toBe("out");
  expect(r.stderr).toBe("err");
  expect(r.timedOut).toBe(false);
});

test("runCommand sends stdin to the process", async () => {
  const r = await runCommand(
    [process.execPath, "-e", "let s=''; process.stdin.on('data',(c)=>s+=c).on('end',()=>process.stdout.write(s.toUpperCase()))"],
    { stdin: "abc" },
  );
  expect(r.stdout).toBe("ABC");
});

test("runCommand kills a command past its timeout", async () => {
  const r = await runCommand([process.execPath, "-e", "setTimeout(()=>{}, 5000)"], { timeoutMs: 100 });
  expect(r.timedOut).toBe(true);
});

test("a command that cannot start reports -1 and an error", async () => {
  const r = await runCommand(["definitely-not-a-real-binary-xyz"]);
  expect(r.code).toBe(-1);
  expect(r.error).toBeTruthy();
});
