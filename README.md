# safescript

[safescript.cc](https://safescript.cc)

A programming language for AI agents. Programs are static DAGs of operations
with a closed instruction set, formal data-flow tracking, and resource bounds
you can inspect before anything runs. No VM, no container, no sandbox needed.

```sh
curl -fsSL https://raw.githubusercontent.com/uriva/safescript/main/install.sh | sh
safescript run script.ss
```

Installs the CLI globally on macOS / Ubuntu. Also available as a library:

```sh
deno add jsr:@uri/safescript     # Deno
npx jsr add @uri/safescript      # npm
```

## Why this exists

AI agents are getting good enough to write and run code. That's the easy part.
The hard part is letting them do it without handing over the keys to the
kingdom.

Today, when an agent needs a capability (call an API, transform data, forward a
credential), there are two options. Give it a general-purpose language and hope for
the best, or restrict it to a handful of hardcoded tools. The first one is a
security nightmare. The second one doesn't scale.

The standard fix for the security problem is to throw a sandbox around it.
Docker containers, microVMs, Firecracker, E2B, whatever. That works, but now
you're paying for it. Every agent execution spins up a container, waits for it
to boot, runs a few API calls, and tears it down. You're burning compute and
time on infrastructure whose only job is to babysit the code. Cold starts add
latency. Orchestration adds complexity. The per-execution cost adds up fast when
you're running thousands of agent tasks a day.

safescript takes a different approach. The language _is_ the sandbox. There's
nothing to escape from because there's nothing dangerous in the instruction set.
No filesystem access, no shell exec, no eval, no dynamic imports. The only
things a program can do are the operations explicitly provided by the host. That
means you can run safescript programs directly in your application process, in
the same runtime as your server. No container spin-up, no VM overhead, no
orchestration layer.

It's a real language with variables, expressions, control flow, imports, and a
growing set of built-in operations. But it's not Turing-complete, and that's the
whole point. Every program compiles down to a static directed acyclic graph of
operations. No dynamic dispatch, no infinite loops. The set of things a program
_can_ do is fully knowable before it runs.

## Every program terminates

safescript is not Turing-complete. That's not a limitation, it's the design.

There are no loops. No recursion. The parser builds a function call graph and
rejects cycles at parse time, both direct recursion and mutual recursion. The
only iteration constructs are `map`, `filter`, and `reduce`, and they operate on
finite arrays. There's no lazy evaluation, no generators, no way to construct
unbounded data.

The result is that every safescript program provably halts. You don't need to
trust the code, reason about convergence, or set timeouts as a safety net. The
language _can't_ express a program that runs forever.

This is the same tradeoff languages like Dhall and SQL (without recursive CTEs)
make. You give up the ability to express every computable function. In exchange
you get a guarantee that no program will hang your system. For AI agent tasks,
that's a trade worth making.

## The supply chain problem

Agent skills today look a lot like npm packages did in 2015. Someone publishes a
capability. An agent installs it. Nobody reads the source. One day the
maintainer pushes an update that exfiltrates inputs to a third-party server,
and you find out about it from a blog post.

safescript makes this structurally impossible. Every program has a
**signature**, a complete static description of what it does, computed without
executing anything. The signature tells you exactly which hosts it contacts,
which environment sources it reads, and how data flows between all of them.

Say an agent skill receives your API key as an input and sends it to
`api.example.com`. That's fine, that's what the skill does. But if an update
adds a second HTTP call that forwards that same key to `evil.io`, the signature
changes. The new host shows up. The data flow from `param:apiKey` to
`host:evil.io` shows up. You can diff signatures between versions and catch this
automatically, before the program ever runs.

This isn't a sandbox or a firewall. It's a proof. The language is constrained
enough that the analysis is exact, not heuristic.

## How signatures work

A signature captures everything a function does without executing it:

```ts
{
  name: "createIdentity",
  params: [{ name: "userId", type: "string" }],
  returnType: { status: "number" },
  hosts: ["agentdocs-api.uriva.deno.net"],             // which hosts are contacted
  envReads: [],                                        // timestamp / randomBytes usage
  dataFlow: {
    "host:agentdocs-api...": ["param:userId"],         // userId flows to the API host
    "return": ["host:agentdocs-api..."],               // what data reaches the return value
  },
  sources: ["host:agentdocs-api..."],            // where the return value came from
  memoryBytes: 1002048,                                // worst-case resource bounds
  runtimeMs: 10020,
  diskBytes: 0,
  complexity: "1",                                     // symbolic complexity expression
}
```

The data flow map is the interesting part. Sources are labeled strings:
`"param:userId"`, `"host:api.com"`, `"env:timestamp"`,
`"env:randomBytes"`. Sinks are `"host:..."` and `"return"`. If
an input value reaches a host, or a host's response reaches another host, it
shows up explicitly in the map.

Resource bounds accumulate from every operation in the program. Each op declares
its own memory, runtime, and disk cost. The signature sums them. For branches
(ternary, if/else), it conservatively takes the union of sources and the sum of
resources from both sides.

### Complexity inference

Signatures now include a symbolic complexity expression derived automatically from
the program structure. The analyzer tracks the size of every value—string length
for strings, element count for arrays—and composes them into a precise Big-O
style formula using parameter names and host labels as variables.

```ts
{
  // ... other signature fields
  complexity: "param:items + host:api.example.com"
}
```

Examples of what the analyzer produces:

- `1` — constant work (e.g., `timestamp()`, `httpRequest`)
- `param:items` — linear in array length (e.g., `map(double, items)`)
- `param:text` — linear in string length (e.g., `sha256({ data: text })`)
- `param:matrix * param:matrix` — quadratic from nested `map` (when inner
  function complexity depends on the outer array)
- `host:api.example.com` — linear in the response body size

The expression is a sum of monomials. Each term is a coefficient times a product
of size variables. Variables are named after the source they measure:

- `param:<name>` — size of parameter `<name>` (string length or array length)
- `host:<hostname>` — size of the response body from `<hostname>`

For `map`/`filter`/`reduce`, the complexity of the inner function is multiplied
by the array length. Currently the element size passed to the inner function is
treated as constant (`1`), so `map(sha256, strings)` where `strings: string[]`
is inferred as `O(n)` in the array length rather than `O(total_chars)`. This is
conservative for most agent skills and may be refined in future versions.

Complexity can later be used as a policy bound: a permission assertion can
require that an imported function stay within `O(n)` or exclude terms above a
certain degree.

## Syntax

safescript looks like a subset of JavaScript but it's actually a DAG description
language. There's no runtime object model, no prototype chain, no closures. Just
operations and data flow.

Top-level constructs — imports, function definitions, and `doc()` annotations —
have no evaluation order. A safescript file is a flat namespace; functions
reference each other by name, not by position. You can define helper functions
before or after the functions that call them, imports can appear anywhere, and
the whole file resolves to a single static graph before anything runs.

### Functions

Files contain one or more named functions. Each takes typed parameters and
returns a value:

```safescript
greet = (name: string, times: number): string => {
  msg = stringConcat({ parts: ["hello, ", name] });
  return msg;
};
```

The return type annotation (`: string` after the parameters) is optional but
recommended.

### Types

Primitives (`string`, `number`, `boolean`), objects
(`{ name: string, age:
number }`), and arrays (`string[]`, `{ id: number }[]`).
Nested combinations work: `{ users: { name: string }[] }`.

### Operations

All computation happens through op calls. Ops take a single object argument with
named fields:

```safescript
hash = sha256({ data: apiKey });
r = httpRequest({
  host: "api.example.com",
  method: "POST",
  path: "/data",
  body: hash,
});
```

Some ops have **static fields** that must be string/number/boolean literals, not
variables. `httpRequest` requires `host` to be a literal. This is enforced at
parse time. It's what makes the signature system work: the set of hosts is
always statically known.

Void calls (ops called for side effects without capturing the return value) work
too:

```safescript
httpRequest({ host: "audit.example.com", method: "POST", path: "/events", body: data });
```

### Expressions

Arithmetic (`+`, `-`, `*`, `/`, `%`), comparisons (`==`, `!=`, `<`, `>`, `<=`,
`>=`), string concatenation (`+`), unary negation (`-x`), ternary
(`cond ? a : b`), dot access (`obj.field.nested`), array literals (`[a, b, c]`),
object literals (`{ key: val, shorthand }`), and parenthesized grouping
(`(a + b) * c`).

Ternary is right-associative, so `a ? b : c ? d : e` means
`a ? b : (c ? d :
e)`. Operator precedence follows the standard math/C
convention.

### Shorthand

Object fields support JS-style shorthand. `{ body }` is sugar for
`{ body: body }`. String keys are supported for non-identifier names:
`{ "x-signature": sig }`.

### Comments

```safescript
// line comments only
```

### Control flow

Statement-level `if`/`else` with Go-like syntax (no parens around condition,
braces required):

```safescript
if x > threshold {
  result = httpRequest({ host: "primary-api.com", method: "POST", path: "/data", body: payload })
} else {
  result = httpRequest({ host: "fallback-api.com", method: "POST", path: "/data", body: payload })
}
```

`else` is optional. An `if` without `else` is valid for conditional side
effects:

```safescript
if shouldCache {
  httpRequest({ host: "cache.example.com", method: "POST", path: "/cache", body: data })
}
```

There's no `else if` keyword. Nest manually:

```safescript
if x > 0 {
  label = "positive"
} else {
  if x == 0 {
    label = "zero"
  } else {
    label = "negative"
  }
}
```

At runtime, only the taken branch executes. The other branch's ops are
completely skipped. For static analysis, both branches are conservatively
analyzed: sources are unioned and resource bounds are summed.

### Map, filter, reduce

safescript has built-in `map`, `filter`, and `reduce` as reserved words. They
take a named function reference (not a lambda) and an array:

```safescript
double = (x: number): number => {
  return x * 2;
};

isPositive = (x: number): boolean => {
  return x > 0;
};

sum = (acc: number, x: number): number => {
  return acc + x;
};

process = (numbers: number[]): number => {
  doubled = map(double, numbers);
  positive = filter(isPositive, doubled);
  total = reduce(sum, 0, positive);
  return total;
};
```

The function comes first, the array comes last. For `reduce`, the initial
accumulator value goes in the middle: `reduce(fn, initial, array)`.

Function arity is enforced. `map` and `filter` require a function that takes
exactly one parameter. `reduce` requires a function that takes exactly two
(accumulator, element).

`map` and `filter` execute in parallel via `Promise.all`. This matters when your
mapped function does network calls. `reduce` executes sequentially since each
step depends on the previous accumulator.

These work with both local functions and imported functions. The function name
must refer to a function defined in the same program or imported from another
file.

### Override

`override(target, { name: replacement, ... })` produces a new callable DAG that
behaves like `target` but with every reference to `name` (an op label or a
user-fn name) rewritten to `replacement` (a user-fn name). Substitution is
transitive: callees of the target are rewritten too, so the swap propagates
all the way down the call graph.

```safescript
fetchExample = (): string => {
  return httpRequest({ host: "example.com", path: "/" });
};

inner = (): string => {
  return httpRequest({ host: "original.com", path: "/" });
};

useFetcher = (): string => {
  return inner();
};

main = (): string => {
  // Swap `inner` for `fetchExample` everywhere inside `useFetcher`.
  f = override(useFetcher, { inner: fetchExample });
  return f();
};
```

The result of `override(...)` is a first-class DAG value. You can:
- invoke it inline: `override(useFetcher, { inner: fetchExample })()`
- bind it to a local and call later: `f = override(...); f()`
- pass it to `map`/`filter`/`reduce` as the function argument

Signatures see through overrides. In the example above, `main`'s signature
reports `example.com` as a host, not `original.com`, because the analyzer
walks the rewritten DAG.

### Imports

safescript programs can import functions from other safescript programs. Imports
go at the top of the file, before any function definitions:

```safescript
import add from "./math.ss" perms {} hash "sha256:abc123..."

sum = (a: number, b: number): number => {
  result = add({ x: a, y: b })
  return result
}
```

The imported function becomes available as a regular op in the local program.
You call it the same way you call any built-in: `add({ x: a, y: b })`.

**Aliasing.** If the imported name conflicts with something local, use `as`:

```safescript
import add as mathAdd from "./math.ss" perms {} hash "sha256:abc123..."
```

**Hash verification.** The `hash` field is a SHA-256 hash of the dependency's
_normalized form_. Normalization strips comments, normalizes whitespace, and
alpha-renames internal variables (parameters become `_p0`, `_p1`; locals become
`_v0`, `_v1`) while preserving function names, op names, and string literals.
This means cosmetic changes (renaming a variable, reformatting) don't break the
hash. Semantic changes do. If the dep's content doesn't match the declared hash,
the build fails.

To get the hash of a program:

```typescript
import { hashProgram } from "safescript";

const hash = await hashProgram(sourceCode);
// "sha256:e3b0c44298fc1c149afbf4c8996fb924..."
```

**Permission assertions.** The `perms` block declares exactly what the imported
function (and all its transitive dependencies) can do. The fields match the
signature: `hosts`, `envReads`, and `dataFlow`.
The first two are arrays of string literals. `dataFlow` is an object mapping
sink labels to arrays of source labels. Missing fields mean empty sets, except
`dataFlow` which is optional: omit it to skip the data flow check.

```safescript
import fetchUser from "https://example.com/user.ss" perms {
  hosts: ["api.example.com"],
  dataFlow: {
    "host:api.example.com": ["param:userId"],
    "return": ["host:api.example.com"]
  }
} hash "sha256:..."
```

This is not a permissions _grant_, it's an _assertion_. The resolver computes
the actual transitive signature of the imported function and checks that it
exactly matches the declared perms. If the dep secretly starts reading a new
host, using a new env source, or routing data somewhere new, the assertion
fails and the build breaks. You must update the perms declaration to acknowledge
the change.

A pure dependency (no hosts, no env reads) uses empty braces:

```safescript
import add from "./math.ss" perms {} hash "sha256:..."
```

**Transitive composition.** Dependencies can have their own imports. The
resolver processes the entire transitive chain. Each dependency's perms are
verified against its full transitive signature. Circular dependencies are
impossible by construction since each import must declare a hash, and you can't
hash something that references itself.

**Diamond dependencies.** If two imports share a common transitive dependency
(same hash), it's resolved once and cached. No duplication.

## Built-in operations

### I/O

| Op                                                     | Static fields | Description                    |
| ------------------------------------------------------ | ------------- | ------------------------------ |
| `httpRequest({ host, method, path, headers?, body? })` | `host`        | HTTPS request to declared host |

### Pure

| Op                          | Description                     |
| --------------------------- | ------------------------------- |
| `jsonParse({ text })`       | Parse JSON string to value      |
| `jsonStringify({ value })`  | Serialize value to JSON string  |
| `stringConcat({ parts })`   | Concatenate an array of strings |
| `base64urlEncode({ data })` | Base64url encode                |
| `base64urlDecode({ data })` | Base64url decode                |
| `pick({ object, keys })`    | Pick keys from an object        |
| `merge({ objects })`        | Shallow merge objects           |
| `sha256({ data })`          | SHA-256 hash                    |

### Crypto

| Op                                           | Description                             |
| -------------------------------------------- | --------------------------------------- |
| `generateEd25519KeyPair()`                   | Generate Ed25519 signing keypair        |
| `generateX25519KeyPair()`                    | Generate X25519 key agreement keypair   |
| `ed25519Sign({ data, privateKey })`          | Sign data with Ed25519                  |
| `aesGenerateKey()`                           | Generate AES-GCM key                    |
| `aesEncrypt({ key, plaintext })`             | AES-GCM encrypt                         |
| `aesDecrypt({ key, ciphertext })`            | AES-GCM decrypt                         |
| `x25519DeriveKey({ privateKey, publicKey })` | Derive shared secret via X25519         |
| `importIdentity({ exported })`               | Import a serialized identity            |
| `exportIdentity({ keys })`                   | Export an identity to serializable form |

### Sources

| Op                        | Description                                              |
| ------------------------- | -------------------------------------------------------- |
| `timestamp()`             | Current Unix timestamp (tagged as non-deterministic)     |
| `randomBytes({ length })` | Cryptographic random bytes (tagged as non-deterministic) |

## Architecture

safescript has two layers.

**The op layer** is a TypeScript library for defining and composing typed
operations (`DagOp` objects). Each op has a Zod input/output schema, a manifest
declaring its resource costs and tags, and a `run` function. This layer includes
`compose()` for building DAGs programmatically and `execute()` for running them.
It's usable on its own if you want to build pipelines in TypeScript.

**The language layer** sits on top. It has a lexer, parser, interpreter, and
signature analyzer. The parser produces an AST, the interpreter walks it and
calls into the op registry, and the signature analyzer walks it without
executing to produce a `Signature`. Programs are `.safescript` files with the
custom syntax described above.

The **op registry** bridges the two layers. It maps string op names (as they
appear in safescript source) to `OpEntry` objects that know which fields are
static and how to create the underlying `DagOp`. The builtin registry covers all
the ops listed above. Custom registries can be passed to both `interpret()` and
`computeSignature()`.

The **execution context** (`ExecutionContext`) provides the external world:
`fetch`. It's injected via `AsyncLocalStorage` so ops access it through
`getContext()` without passing it as an argument.

## Usage

```typescript
import {
  builtinRegistry,
  computeSignature,
  interpret,
  parse,
  tokenize,
} from "safescript";

const source = `
  fetchData = (userId: string) => {
    body = jsonStringify({ value: { userId } })
    result = httpRequest({
      host: "api.example.com",
      method: "POST",
      path: "/lookup",
      body
    })
    return result
  }
`;

// Parse
const program = parse(tokenize(source));

// Static analysis (no execution, no context needed)
const sig = computeSignature(program, "fetchData");
console.log(sig.hosts); // Set { "api.example.com" }
console.log(sig.dataFlow); // param:userId flows to host:api.example.com, etc.

// Execute (requires context)
const result = await interpret(program, "fetchData", { userId: "alice" }, {
  fetch: globalThis.fetch,
});
```

### Testing safescript programs

Tests are written in safescript itself. Use `assert` for checks, `override` to
mock side effects, and `safescript test` to run:

```
import { createDocument } from "../scripts/create-document.ss"

mockHttpRequest = (host: string, method: string, path: string, ...) => {
  return { status: 201, body: "{\"document\":{\"id\":\"mock\"}}" }
}

testCreateDocument = () => {
  result = override(createDocument, { httpRequest: mockHttpRequest })("Test", "Content", id)
  assert({ condition: result.status == 201 })
  return { ok: true }
}
```

`safescript test` runs all zero-input functions and reports pass/fail:

```sh
safescript test tests/create-document-test.ss
# ok  testCreateDocument
# 1/1 passed
```

For static analysis assertions, use the programmatic API:

```typescript
import { computeSignature, parse, tokenize } from "@uri/safescript";

const program = parse(tokenize(source));
const sig = computeSignature(program, "main");
assertEquals(sig.hosts.size, 0);
```

## Transpilers

safescript programs can be transpiled to runnable TypeScript or Python. The
transpilers emit self-contained code with a full runtime preamble that
implements all built-in operations. No safescript runtime dependency is needed
to run the output.

### TypeScript

```typescript
import { parse, tokenize, toTypescript } from "safescript";

const source = `
  greet = (name: string): string => {
    msg = stringConcat({ parts: ["hello, ", name] })
    return msg
  }
`;

const program = parse(tokenize(source));
const tsCode = toTypescript(program);
// or: toTypescript(program, "greet") to emit only one function
```

The output uses the Web Crypto API for all crypto operations. Each function
takes its parameters as a `Record<string, any>` plus an `ExecutionContext` for
IO ops (`httpRequest`). Functions that only use
pure ops still require the context parameter for a uniform interface.

### Python

```typescript
import { parse, tokenize, toPython } from "safescript";

const program = parse(tokenize(source));
const pyCode = toPython(program);
// or: toPython(program, "greet") to emit only one function
```

The output uses `asyncio` for async execution, `aiohttp` for HTTP requests, and
the `cryptography` package for crypto operations. Functions use Python
keyword-only arguments (`*, param1, param2, _ctx`). Booleans emit as
`True`/`False`, objects as dicts.

Both transpilers support the `functionName` parameter to emit a single function.
If omitted, all functions in the program are emitted.

## CLI

```
safescript run <file.ss> [fn] [--args '{"key":"val"}']
safescript signature <file.ss> [fn]
safescript transpile-ts <file.ss> [fn]
safescript transpile-py <file.ss> [fn]
safescript test <file.ss>
safescript skill <file.ss>
```

### Running programs

```sh
safescript run script.ss                    # auto-detects main() or first fn
safescript run script.ss greet --args '{"name":"World"}'
```

### Testing

`safescript test <file.ss>` runs every zero-input function and reports
pass/fail. Use `assert` and `override` to mock side effects — no TypeScript
wrapper needed:

```
import { createDocument } from "../scripts/create-document.ss"

mockHttpRequest = (host: string, ...) => {
  return { status: 201, body: "{\"document\":{\"id\":\"mock\"}}" }
}

testCreateDocument = () => {
  result = override(createDocument, { httpRequest: mockHttpRequest })("Test")
  assert({ condition: result.status == 201 })
  return { ok: true }
}
```

Run with: `safescript test tests/some-test.ss`

### Generating documentation

Use `doc()` annotations in your safescript source, then generate markdown:

```
doc({ text: "My module description..." })

myFn = (x: string): string => {
  doc({ target: myFn, text: "Takes a string, returns it." })
  return x
}
```

```sh
safescript skill script.ss > SKILL.md
```

Module-level `doc({text: ...})` and function-targeted
`doc({target: fn, text: ...})` are both supported.

## What this doesn't do

safescript is not a general-purpose language. You can't write a web server in it
or sort a list. There's no recursion, no unbounded loops, no dynamic dispatch.
It's a language for writing agent skills that interact with APIs and inputs in
a way that can be formally reasoned about.

If you need Turing-completeness, use a real language and accept the security
tradeoffs. If you need provable safety with useful capabilities, this is the
trade you make.
