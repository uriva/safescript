import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("cli test discovers .ss files under tests", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/github/tests`, { recursive: true });
    await Deno.mkdir(`${dir}/github/scripts`, { recursive: true });
    await Deno.writeTextFile(`${dir}/github/tests/passing.ss`, `passes = () => {\n  return true\n}\n`);
    await Deno.writeTextFile(`${dir}/github/scripts/not_a_test.ss`, `ignored = () => {\n  assert({ condition: false, message: "should not run" })\n  return true\n}\n`);

    const command = new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-all", `${Deno.cwd()}/cli.ts`, "test"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);

    assertEquals(output.code, 0, stderr);
    assertStringIncludes(stdout, "github/tests/passing.ss");
    assertStringIncludes(stdout, "ok  passes");
    assertStringIncludes(stdout, "1/1 passed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
