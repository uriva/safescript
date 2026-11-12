# Safescript Language Reference

Safescript is a Turing-incomplete, statically verified subset/dialect of
TypeScript. Programs compile to static Directed Acyclic Graphs (DAGs) with exact
host, data-flow, resource, and complexity signatures—no VM or container sandbox
required.

## 1. Critical Differences from JavaScript / TypeScript

| Concept              | JS / TS (Rejected)              | Safescript (Valid)                                                                         |
| :------------------- | :------------------------------ | :----------------------------------------------------------------------------------------- |
| Variable assignment  | `const x = 1` / `let y = 2`     | `x = 1` (no `const`/`let`/`var`; semicolons optional)                                      |
| Function declaration | `export async function f(x) {}` | `f = (x: number): number => { return x * 2 }` (no `async`/`await`/`export`)                |
| HTTP requests        | `await fetch("https://...")`    | `httpRequest("https://api.com/path")` or `httpRequest({ host: "api.com", path: "/path" })` |
| Loops                | `for (...)`, `while (...)`      | `map(fn, arr)`, `filter(fn, arr)`, `reduce(fn, init, arr)`                                 |
| Array methods        | `arr.map(x => x * 2)`           | `map((x) => x * 2, arr)` (top-level `map`/`filter`/`reduce`)                               |
| Dynamic host         | `httpRequest({ host: dynVar })` | `host` (or `url` in unary/object `httpRequest`) **must** be a string literal               |
| Error handling       | `try { ... } catch (e) {}`      | Check `res.status == 200` with `if` / `else if` / ternary                                  |

**Forbidden constructs:** `const`/`let`/`var`, `async`/`await`/`export`,
`for`/`while`, recursion (direct or mutual), classes, `new`,
`try`/`catch`/`throw`, parameter destructuring.

## 2. Program Structure, Types & Functions

A file contains optional `import` declarations, optional `type` aliases,
optional `doc(...)` annotations, and named functions in any order:

```safescript
type Lead = { id: string, company: string, active: boolean }

formatLead = (lead: Lead, prefix: string = "Lead"): string => {
  return `${prefix}: ${lead.company}`
}

activeSummaries = (leads: Lead[], tag: string): string[] => {
  active = filter((l) => l.active, leads)
  return map((l) => formatLead({ lead: l, prefix: tag }), active)
}
```

- **Types (optional — inferred when omitted):**
  - Primitives: `string`, `number`, `boolean` (`any` / `unknown` also accepted
    as inferred)
  - Arrays & Objects: `string[]`, `{ name: string, scores: number[] }[]`
  - Type aliases: `type User = { id: number, name: string }`
  - Note: bare `: object` is not a type — omit the annotation or specify fields
    `{ key: string }`.
- **Calling user functions:**
  - Positional: `myFn(arg1, arg2)`
  - Named object: `myFn({ param1: arg1, param2: arg2 })` (required when the
    function declares default parameter values like `prefix: string = "Lead"`).
- **Control flow & early returns:**
  ```safescript
  classify = (n: number): string => {
    if n > 0 {
      return "positive"
    } else if n == 0 {
      return "zero"
    } else {
      return "negative"
    }
  }
  ```
  Parentheses around `if` conditions are optional (`if (x == 1) { ... }` works
  too). Variables assigned before a `return` must precede their use.

## 3. Expressions, Strings, Spread & Iteration

- **Literals:** `"double"`, `'single'`, `` `template ${expr}` ``, `42`, `3.14`,
  `true`, `false`, `null`, `undefined`, `[1, 2]`, `{ a: 1, shorthand }`.
- **String interpolation & `+`:**
  - Template literals `` `/users/${userId}?page=${page}` `` safely coerce
    strings, numbers, booleans, and nullish values (and throw `TypeError` on
    objects/arrays—use `jsonStringify(obj)` for JSON).
  - `+` adds numbers or concatenates strings with primitives (`"Order #" + 42`).
- **Object & Array spread:**
  - Object spread: `nextState = { ...state, count: state.count + 1 }`
  - Array spread: `nextItems = [...state.items, newItem]`
- **UI tag expressions (desugars statically to `{ tag, attrs, on, children }`):**
  - Supports HTML tags (`<form onSubmit={add}>`, `<input name="company" required />`), built-in UI primitives (`<Card title="CRM">`, `<Table rows={items} />`, `<Stat label="MRR" value="$12k" />`, `<Badge variant="success">Won</Badge>`), fragments (`<>...</>`), `{/* comments */}`, `{...spread}`, and non-recursive user-defined Capitalized components.
  - Functions support both block bodies (`f = (x) => { return x }`) and expression bodies (`f = (x) => (<Card>{x}</Card>)`).
- **Operators (low → high precedence):** `cond ? a : b`, `||`, `&&`,
  `== != < > <= >=`, `+ -`, `* / %`, `-x !x typeof x`, `obj.field` / `arr[i]`.
- **String & Array dot helpers:**
  - `.length` on arrays and strings
  - String methods: `s.slice(start, end?)` / `s.substring(...)`,
    `s.split(delim)`, `s.includes(sub)`, `s.toLowerCase()`, `s.toUpperCase()`,
    `s.trim()`, `s.startsWith(p)`, `s.endsWith(s)`, `s.replace(a, b)`,
    `s.replaceAll(a, b)`
  - Array methods: `arr.slice(start, end?)`, `arr.join(delim?)`
  - Standard globals: `JSON.parse(s)`, `JSON.stringify(v)`, `Object.keys(o)`
- **Iteration (`map`, `filter`, `reduce`):**
  - `map(fn, array)` — parallel 1-arg transform (`(el) => ...`)
  - `filter(fn, array)` — parallel 1-arg predicate (`(el) => ...`)
  - `reduce(fn, initial, array)` — sequential 2-arg fold (`(acc, el) => ...`)
  - Inline arrow functions inside `map`/`filter`/`reduce` **can read outer
    variables/parameters**:
    ```safescript
    toggleTodo = (todos: { id: number, done: boolean }[], targetId: number) => {
      return map((t) => t.id == targetId ? { ...t, done: !t.done } : t, todos)
    }
    ```

## 4. Built-in Operations Reference

Ops accept named arguments `op({ key: val })`; ops marked **(unary)** also
accept `op(val)`, and ops marked **(pos)** accept positional args.

### I/O & Meta

- `httpRequest` **(unary `url`)**:
  `httpRequest("https://api.example.com/items")` or
  `httpRequest({ host: "api.example.com", method: "POST", path: "/items", headers: { Authorization:`Bearer
  ${token}`}, body: jsonStringify(payload), timeout: 60000, subdomain: "eu" })`
  → `{ status: number, body: string }`. (`host` or `url` must be a static string
  literal; `timeout` is in ms, default `60000`.)
- `assert` **(unary `condition`)**: `assert(x == 42)` or
  `assert({ condition: x == 42, message: "bad x" })` → `{ ok: true }`.
- `doc`: `doc({ text: "Module docs" })` or
  `doc({ target: myFn, text: "Fn docs" })`.

### JSON, Type & Object Ops

- `jsonParse` / `parseJson` **(unary `text`)**: `jsonParse(str)` → parsed value
  directly (`.value` also supported for legacy compatibility). Auto-repairs
  invalid backslash escapes.
- `jsonStringify` **(unary `value`)**: `jsonStringify(val)` → `string`.
  (`stringStringify` returns `{ text: string }`.)
- `typeOf` / `typeof` **(unary `value`)**: returns
  `"string" | "number" | "boolean" | "array" | "object" | "null" | "undefined"`.
- `toString` **(unary `value`)**: converts primitive/nullish value to `string`
  (throws on object/array).
- `len` **(unary `value`)**: `len(arrOrStr)` → `number`.
- `objectKeys` / `keys` **(unary `obj`)**: `keys(obj)` → `string[]`.
- `merge`: `merge({ a: obj1, b: obj2 })` → `{ result: object }` (prefer
  `{ ...obj1, ...obj2 }`).
- `pick` **(pos `obj, keys`)**: `pick(obj, ["id", "name"])` or
  `pick({ obj, keys: ["id"] })` → `{ result: object, obj: object }`.

### String & Array Ops

- `stringConcat` **(unary `parts`)**: `stringConcat(["a", "b"])` →
  `{ result: string }` (prefer `` `${a}${b}` ``).
- `stringSplit` / `split` **(pos `text, delimiter`)**: `split(str, ",")` →
  `{ parts: string[] }`.
- `stringSlice` / `slice` **(pos `text, start, end?`)**: `slice(strOrArr, 0, 5)`
  → sliced string or array directly.
- `stringIncludes` **(pos `haystack, needle`)**: `stringIncludes(str, "sub")` →
  `{ result: boolean }` (or `str.includes("sub")` → `boolean`).
- `stringStartsWith` **(pos `text, prefix`)**: `stringStartsWith(str, "pre")` or
  `str.startsWith("pre")` → `boolean`.
- `stringEndsWith` **(pos `text, suffix`)**: `stringEndsWith(str, "suf")` or
  `str.endsWith("suf")` → `boolean`.
- `stringLower` **(unary `text`)**: `stringLower(str)` → `{ result: string }`
  (or `str.toLowerCase()` → `string`).
- `stringUpper` **(unary `text`)**: `stringUpper(str)` or `str.toUpperCase()` →
  `string`.
- `stringTrim` / `trim` **(unary `text`)**: `trim(str)` or `str.trim()` →
  `string`.
- `stringReplace` **(pos `haystack, needle, replacement, all?`)**:
  `stringReplace({ haystack, needle, replacement, all: true })` →
  `{ result: string, count: number }`.
- `stringRegex` **(pos `text, pattern`)**: `stringRegex(str, "id=(\\d+)")` →
  `{ match: boolean, groups: string[] }`.
- `urlEncode` **(unary `text`)**: `urlEncode(str)` → `{ encoded: string }`.
- `base64urlEncode` **(unary `text`)**: `base64urlEncode(str)` →
  `{ encoded: string }`.
- `base64urlDecode` **(unary `encoded`)**: `base64urlDecode(b64)` →
  `{ text: string }`.
- `buildMultipartBody`:
  `buildMultipartBody({ fields: { k: "v" }, files: [{ name, filename, content, contentType }] })`
  → `{ body: string, boundary: string }`.
- `arrayAppend` **(pos `array, element`)**: `arrayAppend(arr, item)` →
  `{ array: any[] }` (prefer `[...arr, item]`).
- `arrayConcat` **(unary `parts`)**: `arrayConcat([arr1, arr2])` → `any[]`
  (prefer `[...arr1, ...arr2]`).
- `arrayJoin` / `join` **(unary `array`, pos `array, delimiter?`)**:
  `join(arr, ", ")` or `arr.join(", ")` → `string`.

### Crypto & Source Ops

- `sha256` **(unary `data`)**: `sha256(str)` → `{ hash: string }` (base64url).
- `generateEd25519KeyPair()` → `{ publicKey: string, privateKey: string }`.
- `ed25519PublicFromPrivate` **(unary `privateKey`)** → `{ publicKey: string }`.
- `ed25519Sign({ data, privateKey })` → `{ signature: string }`.
- `generateX25519KeyPair()` → `{ publicKey: string, privateKey: string }`.
- `x25519PublicFromPrivate` **(unary `privateKey`)** → `{ publicKey: string }`.
- `x25519DeriveKey({ myPrivateKey, theirPublicKey, salt, info })` →
  `{ derivedKey: string }`.
- `aesGenerateKey()` → `{ key: string }`.
- `aesEncrypt({ plaintext, key })` → `{ ciphertext: string, iv: string }`.
- `aesDecrypt({ ciphertext, iv, key })` → `{ plaintext: string }`.
- `timestamp()` → `{ timestamp: number }` (ms; marks `env:timestamp`).
- `randomBytes` **(unary `length`)**: `randomBytes(32)` → `{ bytes: string }`
  (base64url; marks `env:randomBytes`).

## 5. Testing (`override`) & Imports

- **Mocking ops or functions with `override`:**
  `override(targetFn, { httpRequest: mockHttp })` returns a rewritten DAG where
  `httpRequest` (even inside transitive callees) is replaced by `mockHttp`. Run
  zero-arg test functions with `safescript test file.ss`.
- **Content-addressed imports (CLI / library):**
  `import helper from "https://example.com/mod.ss" perms { hosts: ["api.example.com"] } hash "sha256:..."`
  (Note: host environments that expose skill functions directly as tools disable
  `import` inside inline `run_safescript` calls.)
