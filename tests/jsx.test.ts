import { assertEquals, assertThrows } from "@std/assert";
import {
  computeSignature,
  interpret,
  parse,
  tokenize,
  toTypescript,
} from "../mod.ts";

const compile = (code: string) => parse(tokenize(code));
const ctx = { fetch: globalThis.fetch };

Deno.test("JSX: minimal CRM card, table, form, and event reference shorthand", async () => {
  const code = `
    add = (lead) => lead

    render = (leads: { company: string, status: string }[]) => (
      <Card title="Leads CRM">
        <Table rows={leads} />
        <form onSubmit={add} className="crm-form">
          <input name="company" placeholder="Company" required />
          <button type="submit">Add</button>
        </form>
      </Card>
    )
  `;
  const prog = compile(code);
  const out = await interpret(
    prog,
    "render",
    { leads: [{ company: "Wix", status: "Qualified" }] },
    ctx,
  ) as Record<string, unknown>;

  assertEquals(out, {
    tag: "card",
    title: "Leads CRM",
    children: [
      {
        tag: "table",
        rows: [{ company: "Wix", status: "Qualified" }],
      },
      {
        tag: "form",
        attrs: { class: "crm-form" },
        on: { submit: "add" },
        children: [
          {
            tag: "input",
            attrs: { name: "company", placeholder: "Company", required: true },
          },
          {
            tag: "button",
            attrs: { type: "submit" },
            children: ["Add"],
          },
        ],
      },
    ],
  });
});

Deno.test("JSX: disambiguates < comparison operator inside and outside JSX", async () => {
  const code = `
    viewCount = (count: number) => {
      isLow = count < 5
      return (
        <div>
          {count < 10 ? <Badge variant="warning">Low: {count}</Badge> : <Badge variant="success">High</Badge>}
          {isLow && <span>Needs attention</span>}
        </div>
      )
    }
  `;
  const prog = compile(code);
  const low = await interpret(prog, "viewCount", { count: 3 }, ctx);
  assertEquals(low, {
    tag: "div",
    children: [
      {
        tag: "badge",
        attrs: { variant: "warning" },
        children: ["Low: ", 3],
      },
      {
        tag: "span",
        children: ["Needs attention"],
      },
    ],
  });

  const high = await interpret(prog, "viewCount", { count: 12 }, ctx);
  assertEquals(high, {
    tag: "div",
    children: [
      {
        tag: "badge",
        attrs: { variant: "success" },
        children: ["High"],
      },
      false,
    ],
  });
});

Deno.test("JSX: fragments, comments, apostrophes/entities, spread attrs, and HOF map with capture", async () => {
  const code = `
    renderList = (items: { id: string, label: string }[], prefix: string) => {
      shared = { "data-kind": "row" }
      return (
        <>
          {/* Header comment */}
          <h2>Don't miss &rarr; deals ($5+)</h2>
          <ul>
            {map((it) => <li {...shared} data-id={it.id}>{prefix}: {it.label}</li>, items)}
          </ul>
        </>
      )
    }
  `;
  const prog = compile(code);
  const out = await interpret(
    prog,
    "renderList",
    {
      items: [{ id: "1", label: "Acme" }],
      prefix: "Lead",
    },
    ctx,
  );
  assertEquals(out, [
    {
      tag: "h2",
      children: ["Don't miss \u2192 deals ($5+)"],
    },
    {
      tag: "ul",
      children: [
        [
          {
            tag: "li",
            attrs: { "data-kind": "row", "data-id": "1" },
            children: ["Lead", ": ", "Acme"],
          },
        ],
      ],
    },
  ]);
});

Deno.test("JSX: user-defined SafeScript components, cycle rejection, and static taint tracking", async () => {
  const code = `
    LeadPill = (props: { status: string }) => (
      <Badge variant={props.status == "Won" ? "success" : "info"}>{props.status}</Badge>
    )

    Metric = (label: string, total: number) => (
      <Stat label={label} value={total} />
    )

    render = (apiToken: string) => {
      res = httpRequest({
        url: "https://api.example.com/leads",
        headers: { Authorization: \`Bearer \${apiToken}\` }
      })
      return (
        <Card title="Pipeline">
          <Metric label="Count" total={3} />
          <LeadPill status={res.body} />
        </Card>
      )
    }
  `;
  const prog = compile(code);
  const sig = computeSignature(prog, "render");
  assertEquals([...sig.hosts], ["api.example.com"]);
  assertEquals(sig.dataFlow.get("host:api.example.com")?.has("param:apiToken"), true);
  assertEquals(sig.dataFlow.get("return")?.has("host:api.example.com"), true);

  // Transpile to JS and verify stripped output parses as clean JS without JSX syntax
  const js = toTypescript(prog, { stripTypes: true, treeShakeOps: true });
  assertEquals(js.includes("<Card"), false);
  assertEquals(js.includes('"card"'), true);

  // Recursive JSX component must still fail cycle detection at parse time
  assertThrows(
    () => compile(`Loop = () => <Loop />`),
    Error,
    "cycle",
  );
});
