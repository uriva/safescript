import {
  builtinRegistry,
  builtinUnaryFields,
  computeSignature,
  interpret,
  parse,
  resolveImports,
  tokenize,
  toPython,
  toTypescript,
} from "./mod.ts";
import type {
  DocAnnotation,
  ExecutionContext,
  FnDef,
  ImportDecl,
  OpEntry,
  Program,
  Statement,
  Value,
} from "./mod.ts";

const USAGE = `safescript — run .ss programs from the command line

Usage:
  safescript [command]

Commands:
  run <file.ss> [function] [--args '{"key":"value"}']   Execute a .ss program
  signature <file.ss> [function]                         Print the program signature
  transpile-ts <file.ss> [function]                      Transpile to TypeScript
  transpile-py <file.ss> [function]                      Transpile to Python
  test [file.ss]                                         Run zero-input functions as tests
  skill <file.ss>                                        Generate SKILL.md from doc() annotations

Examples:
  safescript run script.ss
  safescript run script.ss main --args '{"name":"world"}'
  safescript signature script.ss
  safescript transpile-ts script.ss > script.ts
  safescript transpile-py script.ss > script.py
  safescript test
  safescript test tests.ss
  safescript skill script.ss > SKILL.md`;

const COMMANDS = new Set([
  "run",
  "signature",
  "transpile-ts",
  "transpile-py",
  "test",
  "skill",
]);

const isUserNamedFn = (fn: FnDef): boolean => !fn.name.startsWith("__lambda_");

const resolveArgs = (raw: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      throw new Error("Arguments must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`Invalid JSON for --args: ${(e as SyntaxError).message}`);
    }
    throw e;
  }
};

const readFile = async (path: string): Promise<string> => {
  try {
    return await Deno.readTextFile(path);
  } catch {
    try {
      const { readFileSync } = await import("node:fs");
      return readFileSync(path, "utf-8");
    } catch (e) {
      throw new Error(`Cannot read file '${path}': ${(e as Error).message}`);
    }
  }
};

const absolutizePath = (path: string): string => {
  if (path.startsWith("file://")) return new URL(path).pathname;
  if (path.startsWith("/")) return path;
  return `${Deno.cwd()}/${path}`;
};

const relativePath = (path: string): string => {
  const cwd = Deno.cwd();
  if (path === cwd) return ".";
  if (path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  return path;
};

const isRemoteUrl = (spec: string): boolean =>
  spec.startsWith("http://") || spec.startsWith("https://");

const resolveSourceLocation = (importerPath: string, spec: string): string =>
  isRemoteUrl(spec)
    ? spec
    : spec.startsWith("/")
    ? spec
    : new URL(spec, `file://${importerPath}`).pathname;

const isLocalUnpinnedImport = (imp: ImportDecl): boolean =>
  !imp.hash && (imp.source.startsWith(".") || imp.source.startsWith("/"));

const nextLambdaOffset = (fns: readonly FnDef[]): number =>
  fns.reduce((max, fn) => {
    const match = /^__lambda_(\d+)$/.exec(fn.name);
    return match ? Math.max(max, Number(match[1]) + 1) : max;
  }, 0);

const renameLambdaIdent = (offset: number) => (name: string): string => {
  const match = /^__lambda_(\d+)$/.exec(name);
  return match && offset > 0 ? `__lambda_${Number(match[1]) + offset}` : name;
};

const shiftValueLambdas = (v: Value, rename: (n: string) => string): Value => {
  switch (v.kind) {
    case "string":
    case "number":
    case "boolean":
    case "null":
    case "undefined":
      return v;
    case "reference":
      return { ...v, name: rename(v.name) };
    case "dot_access":
      return { ...v, base: shiftValueLambdas(v.base, rename) };
    case "index_access":
      return {
        ...v,
        base: shiftValueLambdas(v.base, rename),
        index: shiftValueLambdas(v.index, rename),
      };
    case "array":
      return {
        ...v,
        elements: v.elements.map((el) => shiftValueLambdas(el, rename)),
      };
    case "object":
      return {
        ...v,
        fields: v.fields.map((f) => ({
          ...f,
          value: shiftValueLambdas(f.value, rename),
        })),
      };
    case "call":
      return {
        ...v,
        args: v.args.map((a) => ({
          ...a,
          value: shiftValueLambdas(a.value, rename),
        })),
      };
    case "user_call":
      return {
        ...v,
        fn: rename(v.fn),
        args: v.args.map((a) => ({
          ...a,
          value: shiftValueLambdas(a.value, rename),
        })),
      };
    case "binary_op":
      return {
        ...v,
        left: shiftValueLambdas(v.left, rename),
        right: shiftValueLambdas(v.right, rename),
      };
    case "unary_op":
      return { ...v, operand: shiftValueLambdas(v.operand, rename) };
    case "ternary":
      return {
        ...v,
        condition: shiftValueLambdas(v.condition, rename),
        then: shiftValueLambdas(v.then, rename),
        else: shiftValueLambdas(v.else, rename),
      };
    case "map":
    case "filter":
      return {
        ...v,
        fn: shiftValueLambdas(v.fn, rename),
        array: shiftValueLambdas(v.array, rename),
        ...(v.captures
          ? {
            captures: v.captures.map((c) => ({
              ...c,
              value: shiftValueLambdas(c.value, rename),
            })),
          }
          : {}),
      };
    case "reduce":
      return {
        ...v,
        fn: shiftValueLambdas(v.fn, rename),
        initial: shiftValueLambdas(v.initial, rename),
        array: shiftValueLambdas(v.array, rename),
        ...(v.captures
          ? {
            captures: v.captures.map((c) => ({
              ...c,
              value: shiftValueLambdas(c.value, rename),
            })),
          }
          : {}),
      };
    case "override":
      return {
        ...v,
        target: rename(v.target),
        replacements: v.replacements.map((r) => ({
          ...r,
          value: rename(r.value),
        })),
      };
    case "dag_call":
      return {
        ...v,
        fn: shiftValueLambdas(v.fn, rename),
        args: v.args.map((a) => ({
          ...a,
          value: shiftValueLambdas(a.value, rename),
        })),
      };
  }
};

const shiftStmtLambdas = (
  stmt: Statement,
  rename: (n: string) => string,
): Statement => {
  switch (stmt.kind) {
    case "assignment":
      return {
        ...stmt,
        name: rename(stmt.name),
        value: shiftValueLambdas(stmt.value, rename),
      };
    case "void_call":
      return {
        ...stmt,
        call: {
          ...stmt.call,
          args: stmt.call.args.map((a) => ({
            ...a,
            value: shiftValueLambdas(a.value, rename),
          })),
        },
      };
    case "user_void_call":
      return {
        ...stmt,
        fn: rename(stmt.fn),
        args: stmt.args.map((a) => ({
          ...a,
          value: shiftValueLambdas(a.value, rename),
        })),
      };
    case "if_else":
      return {
        ...stmt,
        condition: shiftValueLambdas(stmt.condition, rename),
        then: stmt.then.map((s) => shiftStmtLambdas(s, rename)),
        else: stmt.else
          ? stmt.else.map((s) => shiftStmtLambdas(s, rename))
          : null,
      };
    case "return":
      return { ...stmt, value: shiftValueLambdas(stmt.value, rename) };
  }
};

const shiftFunctionsLambdas = (
  fns: readonly FnDef[],
  offset: number,
): readonly FnDef[] => {
  if (offset === 0) return fns;
  const rename = renameLambdaIdent(offset);
  return fns.map((fn) => ({
    ...fn,
    name: rename(fn.name),
    body: fn.body.map((s) => shiftStmtLambdas(s, rename)),
    returnValue: shiftValueLambdas(fn.returnValue, rename),
  }));
};

const bundleLocalImports = async (
  sourcePath: string,
  visited: ReadonlySet<string>,
): Promise<{
  readonly ownFunctions: readonly FnDef[];
  readonly program: Program;
}> => {
  const source = await readFile(sourcePath);
  const rawProgram = parse(tokenize(source), builtinUnaryFields);
  const localImports = rawProgram.imports.filter(isLocalUnpinnedImport);
  const pinnedImports = rawProgram.imports.filter(
    (imp) => !isLocalUnpinnedImport(imp),
  );
  const nextVisited = new Set([...visited, sourcePath]);

  const merged = await localImports.reduce<
    Promise<{
      readonly functions: readonly FnDef[];
      readonly imports: readonly ImportDecl[];
    }>
  >(
    async (accPromise, imp) => {
      const acc = await accPromise;
      const depPath = resolveSourceLocation(sourcePath, imp.source);
      if (nextVisited.has(depPath)) {
        throw new Error(`Circular import detected: '${imp.source}'`);
      }
      const dep = await bundleLocalImports(depPath, nextVisited);
      imp.names.forEach((name) => {
        if (!dep.program.functions.some((f) => f.name === name)) {
          throw new Error(`Import '${name}' not found in ${imp.source}`);
        }
      });
      const shiftedFns = shiftFunctionsLambdas(
        dep.program.functions,
        nextLambdaOffset(acc.functions),
      );
      const existingNames = new Set(acc.functions.map((f) => f.name));
      const newFns = shiftedFns.filter((f) => !existingNames.has(f.name));
      return {
        functions: [...acc.functions, ...newFns],
        imports: [...acc.imports, ...dep.program.imports],
      };
    },
    Promise.resolve({
      functions: rawProgram.functions,
      imports: pinnedImports,
    }),
  );

  return {
    ownFunctions: rawProgram.functions,
    program: {
      imports: merged.imports,
      functions: merged.functions,
      docs: rawProgram.docs,
    },
  };
};

const loadCliProgram = async (
  sourcePath: string,
): Promise<{
  readonly ownFunctions: readonly FnDef[];
  readonly program: Program;
  readonly registry: ReadonlyMap<string, OpEntry>;
}> => {
  const { ownFunctions, program } = await bundleLocalImports(
    sourcePath,
    new Set(),
  );
  const fetchSource = async (spec: string): Promise<string> => {
    const loc = resolveSourceLocation(sourcePath, spec);
    if (isRemoteUrl(loc)) {
      const res = await fetch(loc);
      if (!res.ok) {
        throw new Error(`Failed to fetch '${spec}': HTTP ${res.status}`);
      }
      return await res.text();
    }
    return await readFile(loc);
  };
  const registry = await resolveImports(program, fetchSource, builtinRegistry);
  return { ownFunctions, program, registry };
};

const discoverTestFiles = async (dir: string): Promise<string[]> => {
  const entries: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      entries.push(...await discoverTestFiles(path));
      continue;
    }
    if (!entry.isFile) continue;
    if (!path.endsWith(".ss")) continue;
    if (!path.includes("/tests/")) continue;
    entries.push(path);
  }
  return entries.sort();
};

const parseRunCliArgs = (
  args: readonly string[],
  idx = 0,
  acc: {
    readonly filePath: string;
    readonly functionName: string;
    readonly fnArgs: Record<string, unknown>;
  } = { filePath: "", functionName: "", fnArgs: {} },
): {
  readonly filePath: string;
  readonly functionName: string;
  readonly fnArgs: Record<string, unknown>;
} => {
  if (idx >= args.length) return acc;
  const arg = args[idx];
  if (arg === "--args") {
    if (idx + 1 >= args.length) {
      console.error("Error: --args requires a JSON string argument");
      process.exit(1);
    }
    return parseRunCliArgs(args, idx + 2, {
      ...acc,
      fnArgs: resolveArgs(args[idx + 1]),
    });
  }
  if (!acc.filePath) {
    return parseRunCliArgs(args, idx + 1, { ...acc, filePath: arg });
  }
  if (!acc.functionName) {
    return parseRunCliArgs(args, idx + 1, { ...acc, functionName: arg });
  }
  console.error(`Error: Unexpected argument: ${arg}`);
  process.exit(1);
};

const defaultEntryFnName = (
  ownFunctions: readonly FnDef[],
): string | undefined => {
  const userFns = ownFunctions.filter(isUserNamedFn);
  const mainFn = userFns.find((f) => f.name === "main");
  return mainFn?.name ?? userFns[0]?.name;
};

const handleRun = async (args: string[]) => {
  const parsed = parseRunCliArgs(args);
  if (!parsed.filePath) {
    console.error("Error: No .ss file specified");
    process.exit(1);
  }

  const sourcePath = absolutizePath(parsed.filePath);
  const { ownFunctions, program, registry } = await loadCliProgram(sourcePath);
  const functionName = parsed.functionName || defaultEntryFnName(ownFunctions);
  if (!functionName) {
    console.error("Error: No functions found in the program");
    process.exit(1);
  }

  const ctx: ExecutionContext = {
    fetch: globalThis.fetch.bind(globalThis),
  };
  const result = await interpret(
    program,
    functionName,
    parsed.fnArgs,
    ctx,
    registry,
    sourcePath,
  );
  console.log(
    typeof result === "string" ? result : JSON.stringify(result, null, 2),
  );
};

const handleSignature = async (args: string[]) => {
  const filePath = args[0];
  if (!filePath) {
    console.error("Error: No .ss file specified");
    process.exit(1);
  }

  const sourcePath = absolutizePath(filePath);
  const { ownFunctions, program, registry } = await loadCliProgram(sourcePath);
  const functionName = args[1] ?? defaultEntryFnName(ownFunctions);
  if (!functionName) {
    console.error("Error: No functions found");
    process.exit(1);
  }

  const sig = computeSignature(program, functionName, registry);
  console.log(JSON.stringify(sig, (_key, value) => {
    if (value instanceof Set) return [...value];
    if (value instanceof Map) return Object.fromEntries(value);
    return value;
  }, 2));
};

const handleTranspile = async (args: string[], lang: "ts" | "py") => {
  const filePath = args[0];
  if (!filePath) {
    console.error("Error: No .ss file specified");
    process.exit(1);
  }

  const sourcePath = absolutizePath(filePath);
  const { ownFunctions, program } = await loadCliProgram(sourcePath);
  const mainFn = ownFunctions.filter(isUserNamedFn).find((f) =>
    f.name === "main"
  );
  const functionName = args[1] ?? mainFn?.name;
  if (!functionName && ownFunctions.filter(isUserNamedFn).length === 0) {
    console.error("Error: No functions found");
    process.exit(1);
  }

  const code = lang === "ts"
    ? toTypescript(program, functionName)
    : toPython(program, functionName);
  console.log(code);
};

const runTestFile = async (
  filePath: string,
): Promise<{ passed: number; failed: number }> => {
  const sourcePath = absolutizePath(filePath);
  const { ownFunctions, program, registry } = await loadCliProgram(sourcePath);
  const userFns = ownFunctions.filter(isUserNamedFn);

  if (userFns.length === 0) {
    console.error("Error: No functions found");
    process.exit(1);
  }

  const ctx: ExecutionContext = {
    fetch: globalThis.fetch.bind(globalThis),
  };

  const tests = userFns.filter((f) => f.params.length === 0);
  if (tests.length === 0) {
    console.error("Error: No zero-input functions found");
    process.exit(1);
  }

  const outcomes = await tests.reduce<Promise<readonly boolean[]>>(
    async (accPromise, fn) => {
      const acc = await accPromise;
      try {
        await interpret(program, fn.name, {}, ctx, registry, sourcePath);
        console.log(`ok  ${fn.name}`);
        return [...acc, true];
      } catch (e) {
        console.log(`FAIL  ${fn.name}  ${(e as Error).message}`);
        return [...acc, false];
      }
    },
    Promise.resolve([]),
  );

  const passed = outcomes.filter(Boolean).length;
  return { passed, failed: outcomes.length - passed };
};

const handleTest = async (args: string[]) => {
  if (args.length > 1) {
    console.error(`Error: Unexpected argument: ${args[1]}`);
    process.exit(1);
  }

  const files = args[0] ? [args[0]] : await discoverTestFiles(Deno.cwd());

  if (files.length === 0) {
    console.error("Error: No .ss test files found under tests/");
    process.exit(1);
  }

  const totals = await files.reduce<
    Promise<{ passed: number; failed: number }>
  >(
    async (accPromise, file) => {
      const acc = await accPromise;
      if (!args[0]) console.log(`\n${relativePath(absolutizePath(file))}`);
      const result = await runTestFile(file);
      return {
        passed: acc.passed + result.passed,
        failed: acc.failed + result.failed,
      };
    },
    Promise.resolve({ passed: 0, failed: 0 }),
  );

  console.log(`\n${totals.passed}/${totals.passed + totals.failed} passed`);
  process.exit(totals.failed > 0 ? 1 : 0);
};

const collectDocs = (
  program: Program,
): readonly DocAnnotation[] => {
  const inlineDocs = program.functions.flatMap((fn) =>
    fn.body.flatMap((stmt): readonly DocAnnotation[] => {
      if (stmt.kind !== "void_call" || stmt.call.op !== "doc") return [];
      const targetArg = stmt.call.args.find((a) => a.key === "target");
      const textArg = stmt.call.args.find((a) => a.key === "text");
      if (!textArg || textArg.value.kind !== "string") return [];
      const target = targetArg?.value.kind === "reference"
        ? targetArg.value.name
        : undefined;
      return [{ target, text: textArg.value.value }];
    })
  );
  return [...program.docs, ...inlineDocs];
};

const handleSkill = async (args: string[]) => {
  const filePath = args[0];
  if (!filePath) {
    console.error("Error: No .ss file specified");
    process.exit(1);
  }
  const sourcePath = absolutizePath(filePath);
  const source = await readFile(sourcePath);
  const program = parse(tokenize(source), builtinUnaryFields);
  const docs = collectDocs(program);

  const moduleDocs = docs.filter((d) => !d.target);
  const fnDocs = docs.filter((d) => d.target);

  const moduleLines = moduleDocs.flatMap((d) => [d.text, ""]);
  const fnLines = fnDocs.length > 0
    ? [
      ...(moduleLines.length > 0 ? ["---\n"] : []),
      ...fnDocs.flatMap((d) => [`## ${d.target!}\n`, d.text, ""]),
    ]
    : [];
  const lines = [...moduleLines, ...fnLines];

  if (lines.length === 0) {
    console.error("Error: No doc() annotations found");
    process.exit(1);
  }

  console.log(lines.join("\n"));
};

const main = async () => {
  const rawArgs = process.argv.slice(2);

  if (
    rawArgs.length === 0 || rawArgs.includes("--help") || rawArgs.includes("-h")
  ) {
    console.log(USAGE);
    process.exit(0);
  }

  const isExplicitCmd = COMMANDS.has(rawArgs[0]);
  const cmd = isExplicitCmd ? rawArgs[0] : "run";
  const rest = isExplicitCmd ? rawArgs.slice(1) : rawArgs.slice(0);

  try {
    switch (cmd) {
      case "run":
        await handleRun(rest);
        break;
      case "signature":
        await handleSignature(rest);
        break;
      case "transpile-ts":
        await handleTranspile(rest, "ts");
        break;
      case "transpile-py":
        await handleTranspile(rest, "py");
        break;
      case "test":
        await handleTest(rest);
        break;
      case "skill":
        await handleSkill(rest);
        break;
      default:
        console.error(`Error: Unknown command '${cmd}'`);
        process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
};

main();
