import { assertEquals, assertStringIncludes } from "@std/assert";
import { hashProgram } from "../mod.ts";

const runCli = async (cwd: string, cliArgs: readonly string[]) => {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", `${Deno.cwd()}/cli.ts`, ...cliArgs],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
};

Deno.test("cli test discovers .ss files under tests", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/github/tests`, { recursive: true });
    await Deno.mkdir(`${dir}/github/scripts`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/github/tests/passing.ss`,
      `passes = () => {\n  return true\n}\n`,
    );
    await Deno.writeTextFile(
      `${dir}/github/scripts/not_a_test.ss`,
      `ignored = () => {\n  assert({ condition: false, message: "should not run" })\n  return true\n}\n`,
    );

    const { code, stdout, stderr } = await runCli(dir, ["test"]);

    assertEquals(code, 0, stderr);
    assertStringIncludes(stdout, "github/tests/passing.ss");
    assertStringIncludes(stdout, "ok  passes");
    assertStringIncludes(stdout, "1/1 passed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test(
  "cli test resolves relative .ss imports, supports override, isolates inline lambdas, and ignores imported 0-arg helpers",
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${dir}/pkg/tests`, { recursive: true });
      await Deno.mkdir(`${dir}/pkg/scripts`, { recursive: true });
      await Deno.writeTextFile(
        `${dir}/pkg/scripts/service.ss`,
        [
          `zeroArgHelper = () => {`,
          `  assert({ condition: false, message: "imported 0-arg helper must not run as a test" })`,
          `  return "unused"`,
          `}`,
          ``,
          `doubleAll = (nums: number[]): number[] => {`,
          `  return map((n: number) => n * 2, nums)`,
          `}`,
          ``,
          `fetchStatus = (host: string): number => {`,
          `  res = httpRequest({ host: host, method: "GET", path: "/health" })`,
          `  return res.status`,
          `}`,
          ``,
        ].join("\n"),
      );
      await Deno.writeTextFile(
        `${dir}/pkg/tests/service_test.ss`,
        [
          `import { doubleAll, fetchStatus } from "../scripts/service.ss"`,
          ``,
          `mockHttp = (host: string, method: string, path: string): { status: number, body: string } => {`,
          `  return { status: 204, body: "ok" }`,
          `}`,
          ``,
          `testOverrideAndLambdas = () => {`,
          `  doubled = doubleAll({ nums: [1, 2, 3] })`,
          `  plusTen = map((x: number) => x + 10, doubled)`,
          `  assert({ condition: plusTen[0] == 12 && plusTen[2] == 16, message: "expected non-colliding lambdas across imported and test modules" })`,
          `  mockedFetch = override(fetchStatus, { httpRequest: mockHttp })`,
          `  status = mockedFetch({ host: "api.example.com" })`,
          `  assert({ condition: status == 204, message: "expected overridden httpRequest status" })`,
          `  return true`,
          `}`,
          ``,
        ].join("\n"),
      );

      const { code, stdout, stderr } = await runCli(dir, ["test"]);

      assertEquals(code, 0, stderr);
      assertStringIncludes(stdout, "pkg/tests/service_test.ss");
      assertStringIncludes(stdout, "ok  testOverrideAndLambdas");
      assertStringIncludes(stdout, "1/1 passed");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "cli run, signature, transpile-ts, and hashed imports work with local .ss modules",
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      const mathSrc = `addOne = (x: number): number => {\n  return x + 1\n}\n`;
      const mathHash = await hashProgram(mathSrc);
      await Deno.writeTextFile(`${dir}/math.ss`, mathSrc);
      await Deno.writeTextFile(
        `${dir}/entry_local.ss`,
        `import { addOne } from "./math.ss"\nmain = (n: number): number => {\n  return addOne({ x: n })\n}\n`,
      );
      await Deno.writeTextFile(
        `${dir}/entry_pinned.ss`,
        `import { addOne } from "./math.ss" perms {} hash "${mathHash}"\nmain = (n: number): number => {\n  return addOne({ x: n })\n}\n`,
      );

      const runLocal = await runCli(dir, [
        "run",
        "entry_local.ss",
        "--args",
        '{"n":41}',
      ]);
      assertEquals(runLocal.code, 0, runLocal.stderr);
      assertEquals(runLocal.stdout.trim(), "42");

      const runPinned = await runCli(dir, [
        "run",
        "entry_pinned.ss",
        "--args",
        '{"n":9}',
      ]);
      assertEquals(runPinned.code, 0, runPinned.stderr);
      assertEquals(runPinned.stdout.trim(), "10");

      const sigRes = await runCli(dir, ["signature", "entry_local.ss"]);
      assertEquals(sigRes.code, 0, sigRes.stderr);
      const parsedSig = JSON.parse(sigRes.stdout);
      assertEquals(parsedSig.name, "main");

      const tsRes = await runCli(dir, ["transpile-ts", "entry_local.ss"]);
      assertEquals(tsRes.code, 0, tsRes.stderr);
      assertStringIncludes(tsRes.stdout, "const addOne =");
      assertStringIncludes(tsRes.stdout, "const main =");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);
