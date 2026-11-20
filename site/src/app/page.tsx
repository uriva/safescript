import fs from "node:fs";
import path from "node:path";
import * as React from "react";
import { ChevronDown } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { MarkdownContent } from "@/components/markdown-content";
import { DocsToc } from "@/components/docs-toc";
import { getVersion } from "@/lib/version";

const getReadmeContent = () => {
  const readmePath = path.join(/*turbopackIgnore: true*/ process.cwd(), "..", "README.md");
  return fs.readFileSync(readmePath, "utf-8");
};

/* Syntax-highlighting token styles (driven by CSS custom properties in globals.css) */
const kw = { color: "var(--sig-purple)" };
const str = { color: "var(--sig-string)" };
const key = { color: "var(--sig-key)" };
const dim = { color: "var(--sig-brace)" };
const warn = { color: "var(--sig-orange)" };
const red = { color: "var(--sig-red)" };

const CodeBlock = ({
  title,
  badge,
  tone = "neutral",
  children,
}: {
  title: string;
  badge?: string;
  tone?: "neutral" | "pass" | "fail";
  children: React.ReactNode;
}) => {
  const borderClass =
    tone === "pass"
      ? "border-emerald-500/50"
      : tone === "fail"
        ? "border-red-500/50"
        : "border-border";
  const dotClass =
    tone === "fail" ? "bg-red-500" : "bg-emerald-500";
  const badgeClass =
    tone === "pass"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500"
      : tone === "fail"
        ? "border-red-500/40 bg-red-500/10 text-red-500"
        : "border-border bg-muted/40 text-muted-foreground";

  return (
    <div className={`overflow-hidden rounded-none border ${borderClass}`}>
      <div
        className="flex items-center justify-between gap-2 border-b border-border px-4 py-2"
        style={{ background: "var(--sig-bar-bg)" }}
      >
        <div className="flex items-center gap-2">
          <span className={`size-2 rounded-full ${dotClass}`} />
          <span className="font-mono text-xs text-muted-foreground">
            {title}
          </span>
        </div>
        {badge && (
          <span
            className={`border px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider uppercase ${badgeClass}`}
          >
            {badge}
          </span>
        )}
      </div>
      <pre
        className="overflow-x-auto p-4 font-mono text-xs leading-relaxed sm:text-[13px]"
        style={{ background: "var(--sig-bg)", color: "var(--sig-text)" }}
      >
        <code>{children}</code>
      </pre>
    </div>
  );
};

const HeroSection = ({ version }: { version?: string }) => (
  <section className="relative overflow-hidden border-b border-border">
    {/* Grid background pattern */}
    <div className="absolute inset-0 bg-[linear-gradient(to_right,var(--color-border)_1px,transparent_1px),linear-gradient(to_bottom,var(--color-border)_1px,transparent_1px)] bg-[size:4rem_4rem] opacity-40" />
    <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-background" />

    <div className="relative mx-auto max-w-6xl px-6 pb-20 pt-32 sm:px-8 lg:px-12">
      <div className="flex flex-col gap-8">
        {/* Badge */}
        {version && (
          <div className="flex">
            <span className="inline-flex items-center gap-2 rounded-none border border-primary/30 bg-primary/5 px-3 py-1.5 font-mono text-xs tracking-wider text-primary uppercase">
              <span className="inline-block size-1.5 rounded-full bg-emerald-500 animate-pulse" />
              v{version}
            </span>
          </div>
        )}

        {/* Title */}
        <h1 className="font-mono text-5xl font-bold tracking-tight sm:text-6xl lg:text-7xl">
          safe
          <span className="text-emerald-500">script</span>
          <span className="ml-4 inline-block text-4xl sm:text-5xl lg:text-6xl">
            😌
          </span>
        </h1>

        {/* Subtitle & explanation */}
        <div className="flex max-w-2xl flex-col gap-3">
          <p className="text-xl font-medium tracking-tight text-foreground sm:text-2xl">
            A programming language for AI agents that doesn&apos;t require code
            review.
          </p>
          <p className="text-base leading-relaxed text-muted-foreground sm:text-lg">
            Turing-<span className="text-emerald-500">in</span>complete by
            design. Every script compiles to a static signature you check
            against a policy before anything runs. No VM, no container, no
            sandbox.
          </p>
        </div>

        {/* CTA row */}
        <div className="flex flex-wrap items-center gap-4 pt-2">
          <a
            href="#docs"
            className="inline-flex h-11 items-center gap-2 rounded-none border border-primary bg-primary px-6 font-mono text-sm text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Read the docs
          </a>
          <a
            href="/llms.txt"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-11 items-center gap-2 rounded-none border border-emerald-500/40 bg-emerald-500/10 px-6 font-mono text-sm text-emerald-500 transition-colors hover:bg-emerald-500/20"
          >
            Agent spec (/llms.txt)
          </a>
          <a
            href="https://app.safescript.cc"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-11 items-center gap-2 rounded-none border border-border bg-background px-6 font-mono text-sm transition-colors hover:bg-muted"
          >
            SafeApp Platform &nearr;
          </a>
          <a
            href="https://github.com/uriva/safescript"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-11 items-center gap-2 rounded-none border border-border bg-background px-6 font-mono text-sm transition-colors hover:bg-muted"
          >
            GitHub
          </a>
        </div>
      </div>
    </div>
  </section>
);

const LanguageShowcase = () => (
  <section className="border-b border-border">
    <div className="mx-auto max-w-5xl px-6 py-16 sm:px-8 sm:py-24 lg:px-12">
      <div className="flex flex-col gap-20">
        {/* 01: Syntax of code */}
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <span className="font-mono text-xs text-emerald-500">01</span>
              <h2 className="font-mono text-sm font-semibold tracking-wide uppercase">
                Code syntax
              </h2>
            </div>
            <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
              Looks like stripped-down TypeScript. Arrow functions, optional
              types, template literals, and{" "}
              <code className="bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                map
              </code>{" "}
              /{" "}
              <code className="bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                filter
              </code>{" "}
              /{" "}
              <code className="bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                reduce
              </code>
              . What&apos;s missing is the whole point: no{" "}
              <code className="bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                for
              </code>{" "}
              or{" "}
              <code className="bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                while
              </code>
              , no recursion, no{" "}
              <code className="bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                eval
              </code>
              , and{" "}
              <code className="bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                host
              </code>{" "}
              on{" "}
              <code className="bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                httpRequest
              </code>{" "}
              must be a string literal.
            </p>
          </div>

          <CodeBlock title="receipts.ss" badge="safescript">
            <div>
              <span style={kw}>type</span> Order ={" "}
              <span style={dim}>{"{"}</span> <span style={key}>id</span>:{" "}
              <span style={warn}>string</span>
              <span style={dim}>,</span> <span style={key}>total</span>:{" "}
              <span style={warn}>number</span>
              <span style={dim}>,</span> <span style={key}>paid</span>:{" "}
              <span style={warn}>boolean</span> <span style={dim}>{"}"}</span>
            </div>
            <div>&nbsp;</div>
            <div>
              sendReceipts = <span style={dim}>(</span>orders:{" "}
              <span style={warn}>Order[]</span>
              <span style={dim}>,</span> apiKey:{" "}
              <span style={warn}>string</span>
              <span style={dim}>) =&gt; {"{"}</span>
            </div>
            <div>
              {"  "}paid = <span style={kw}>filter</span>
              <span style={dim}>((</span>o<span style={dim}>) =&gt;</span>{" "}
              o.paid<span style={dim}>,</span> orders
              <span style={dim}>)</span>
            </div>
            <div>
              {"  "}
              <span style={kw}>return</span> <span style={kw}>map</span>
              <span style={dim}>((</span>o<span style={dim}>) =&gt;</span>{" "}
              <span style={kw}>httpRequest</span>
              <span style={dim}>({"{"}</span>
            </div>
            <div>
              {"    "}
              <span style={key}>host</span>:{" "}
              <span style={str}>&quot;api.resend.com&quot;</span>
              <span style={dim}>,</span>{" "}
              <span style={dim}>{"// must be a string literal"}</span>
            </div>
            <div>
              {"    "}
              <span style={key}>method</span>:{" "}
              <span style={str}>&quot;POST&quot;</span>
              <span style={dim}>,</span>
            </div>
            <div>
              {"    "}
              <span style={key}>path</span>:{" "}
              <span style={str}>&quot;/emails&quot;</span>
              <span style={dim}>,</span>
            </div>
            <div>
              {"    "}
              <span style={key}>headers</span>:{" "}
              <span style={dim}>{"{"}</span>{" "}
              <span style={key}>authorization</span>:{" "}
              <span style={str}>`Bearer ${"{"}apiKey{"}"}`</span>{" "}
              <span style={dim}>{"}"},</span>
            </div>
            <div>
              {"    "}
              <span style={key}>body</span>:{" "}
              <span style={kw}>jsonStringify</span>
              <span style={dim}>({"{"}</span>{" "}
              <span style={key}>orderId</span>: o.id
              <span style={dim}>,</span> <span style={key}>total</span>:{" "}
              o.total <span style={dim}>{"}"})</span>
            </div>
            <div>
              {"  "}
              <span style={dim}>{"}"}),</span> paid<span style={dim}>)</span>
            </div>
            <div>
              <span style={dim}>{"}"}</span>
            </div>
          </CodeBlock>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="border border-border bg-card/40 p-4">
              <div className="font-mono text-xs font-semibold text-emerald-500">
                Literal hosts only
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                Dynamic URLs are rejected at parse time, so every destination a
                script can reach is known statically.
              </p>
            </div>
            <div className="border border-border bg-card/40 p-4">
              <div className="font-mono text-xs font-semibold text-emerald-500">
                Every program halts
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                No loops and no recursion. Iteration only runs over finite
                arrays via{" "}
                <code className="font-mono text-[11px] text-foreground">
                  map
                </code>
                ,{" "}
                <code className="font-mono text-[11px] text-foreground">
                  filter
                </code>
                , and{" "}
                <code className="font-mono text-[11px] text-foreground">
                  reduce
                </code>
                .
              </p>
            </div>
            <div className="border border-border bg-card/40 p-4">
              <div className="font-mono text-xs font-semibold text-emerald-500">
                Closed op set
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                No filesystem, no shell, no{" "}
                <code className="font-mono text-[11px] text-foreground">
                  eval
                </code>
                . A script can only call ops the host explicitly registers.
              </p>
            </div>
          </div>
        </div>

        {/* 02: Syntax of policy */}
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <span className="font-mono text-xs text-emerald-500">02</span>
              <h2 className="font-mono text-sm font-semibold tracking-wide uppercase">
                Policy syntax
              </h2>
            </div>
            <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
              Instead of reviewing code, you check its static signature against
              a policy. Enforce it from your TypeScript host when running agent
              scripts, or declare{" "}
              <code className="bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                perms
              </code>{" "}
              directly on{" "}
              <code className="bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                .ss
              </code>{" "}
              imports.
            </p>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <div className="flex flex-col gap-3">
              <CodeBlock title="verify.ts" badge="host policy">
                <div>
                  <span style={kw}>import</span>{" "}
                  <span style={dim}>{"{"}</span>
                </div>
                <div>{"  "}checkSignatureAgainstPolicy,</div>
                <div>{"  "}computeSignature, parse, tokenize,</div>
                <div>
                  <span style={dim}>{"}"}</span> <span style={kw}>from</span>{" "}
                  <span style={str}>&quot;@uri/safescript&quot;</span>
                </div>
                <div>&nbsp;</div>
                <div>
                  <span style={kw}>const</span> sig ={" "}
                  <span style={key}>computeSignature</span>
                  <span style={dim}>(</span>
                </div>
                <div>
                  {"  "}
                  <span style={key}>parse</span>
                  <span style={dim}>(</span>
                  <span style={key}>tokenize</span>
                  <span style={dim}>(</span>source<span style={dim}>)),</span>{" "}
                  <span style={str}>&quot;sendReceipt&quot;</span>
                </div>
                <div>
                  <span style={dim}>)</span>
                </div>
                <div>&nbsp;</div>
                <div>
                  <span style={kw}>const</span> violations ={" "}
                  <span style={key}>checkSignatureAgainstPolicy</span>
                  <span style={dim}>(</span>
                </div>
                <div>{"  "}sig,</div>
                <div>
                  {"  "}
                  <span style={kw}>new</span> <span style={warn}>Map</span>
                  <span style={dim}>([[</span>
                  <span style={str}>&quot;apiKey&quot;</span>
                  <span style={dim}>,</span>{" "}
                  <span style={str}>&quot;RESEND_API_KEY&quot;</span>
                  <span style={dim}>]]),</span>
                </div>
                <div>
                  {"  "}
                  <span style={kw}>new</span> <span style={warn}>Map</span>
                  <span style={dim}>([[</span>
                  <span style={str}>&quot;RESEND_API_KEY&quot;</span>
                  <span style={dim}>,</span> <span style={kw}>new</span>{" "}
                  <span style={warn}>Set</span>
                  <span style={dim}>([</span>
                  <span style={str}>&quot;api.resend.com&quot;</span>
                  <span style={dim}>])]]),</span>
                </div>
                <div>
                  <span style={dim}>)</span>
                </div>
              </CodeBlock>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Maps parameters to secrets and pins each secret to its allowed
                hosts (plus complexity bounds). Need custom rules for DB columns
                or tenant labels? Pass a predicate to{" "}
                <code className="font-mono text-[11px] text-foreground">
                  checkSignatureAgainstRelation(sig, (labels, sink) =&gt; ...)
                </code>
                .
              </p>
            </div>

            <div className="flex flex-col gap-3">
              <CodeBlock title="main.ss" badge="import perms">
                <div>
                  <span style={kw}>import</span> sendReceipts{" "}
                  <span style={kw}>from</span>{" "}
                  <span style={str}>
                    &quot;https://example.com/receipts.ss&quot;
                  </span>
                </div>
                <div>
                  {"  "}
                  <span style={kw}>perms</span> <span style={dim}>{"{"}</span>
                </div>
                <div>
                  {"    "}
                  <span style={key}>hosts</span>:{" "}
                  <span style={dim}>[</span>
                  <span style={str}>&quot;api.resend.com&quot;</span>
                  <span style={dim}>],</span>
                </div>
                <div>
                  {"    "}
                  <span style={key}>dataFlow</span>:{" "}
                  <span style={dim}>{"{"}</span>
                </div>
                <div>
                  {"      "}
                  <span style={str}>&quot;host:api.resend.com&quot;</span>:{" "}
                  <span style={dim}>[</span>
                  <span style={str}>&quot;param:orders&quot;</span>
                  <span style={dim}>,</span>{" "}
                  <span style={str}>&quot;param:apiKey&quot;</span>
                  <span style={dim}>],</span>
                </div>
                <div>
                  {"      "}
                  <span style={str}>&quot;return&quot;</span>:{" "}
                  <span style={dim}>[</span>
                </div>
                <div>
                  {"        "}
                  <span style={str}>&quot;param:orders&quot;</span>
                  <span style={dim}>,</span>{" "}
                  <span style={str}>&quot;param:apiKey&quot;</span>
                  <span style={dim}>,</span>
                </div>
                <div>
                  {"        "}
                  <span style={str}>&quot;host:api.resend.com&quot;</span>
                </div>
                <div>
                  {"      "}
                  <span style={dim}>]</span>
                </div>
                <div>
                  {"    "}
                  <span style={dim}>{"}"}</span>
                </div>
                <div>
                  {"  "}
                  <span style={dim}>{"}"}</span>
                </div>
                <div>
                  {"  "}
                  <span style={kw}>hash</span>{" "}
                  <span style={dim}>
                    &quot;sha256:7f0c404c7ea1...&quot;
                  </span>
                </div>
              </CodeBlock>
              <p className="text-xs leading-relaxed text-muted-foreground">
                On imports,{" "}
                <code className="font-mono text-[11px] text-foreground">
                  perms
                </code>{" "}
                asserts the exact transitive signature (hosts, env reads, and
                data flow) while{" "}
                <code className="font-mono text-[11px] text-foreground">
                  hash
                </code>{" "}
                locks the normalized AST. If a dependency starts sending data
                somewhere new, the build fails.
              </p>
            </div>
          </div>
        </div>

        {/* 03: One that passes, one that breaks */}
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <span className="font-mono text-xs text-emerald-500">03</span>
              <h2 className="font-mono text-sm font-semibold tracking-wide uppercase">
                One that passes, one that breaks
              </h2>
            </div>
            <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
              Checked against the exact policy above:{" "}
              <code className="bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                apiKey
              </code>{" "}
              is pinned to{" "}
              <code className="bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                api.resend.com
              </code>
              . Both scripts talk to Resend and Slack. Only one line differs.
            </p>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* PASS example */}
            <div className="flex flex-col gap-3">
              <CodeBlock title="pass.ss" badge="pass · 0 violations" tone="pass">
                <div>
                  sendReceipt = <span style={dim}>(</span>orderId:{" "}
                  <span style={warn}>string</span>
                  <span style={dim}>,</span> apiKey:{" "}
                  <span style={warn}>string</span>
                  <span style={dim}>) =&gt; {"{"}</span>
                </div>
                <div>
                  {"  "}res = <span style={kw}>httpRequest</span>
                  <span style={dim}>({"{"}</span>
                </div>
                <div>
                  {"    "}
                  <span style={key}>host</span>:{" "}
                  <span style={str}>&quot;api.resend.com&quot;</span>
                  <span style={dim}>,</span>
                </div>
                <div>
                  {"    "}
                  <span style={key}>method</span>:{" "}
                  <span style={str}>&quot;POST&quot;</span>
                  <span style={dim}>,</span>{" "}
                  <span style={key}>path</span>:{" "}
                  <span style={str}>&quot;/emails&quot;</span>
                  <span style={dim}>,</span>
                </div>
                <div>
                  {"    "}
                  <span style={key}>headers</span>:{" "}
                  <span style={dim}>{"{"}</span>{" "}
                  <span style={key}>authorization</span>:{" "}
                  <span style={str}>`Bearer ${"{"}apiKey{"}"}`</span>{" "}
                  <span style={dim}>{"}"},</span>
                </div>
                <div>
                  {"    "}
                  <span style={key}>body</span>:{" "}
                  <span style={kw}>jsonStringify</span>
                  <span style={dim}>({"{"}</span> orderId{" "}
                  <span style={dim}>{"}"})</span>
                </div>
                <div>
                  {"  "}
                  <span style={dim}>{"}"})</span>
                </div>
                <div>
                  {"  "}
                  <span style={kw}>httpRequest</span>
                  <span style={dim}>({"{"}</span>
                </div>
                <div>
                  {"    "}
                  <span style={key}>host</span>:{" "}
                  <span style={str}>&quot;hooks.slack.com&quot;</span>
                  <span style={dim}>,</span>
                </div>
                <div>
                  {"    "}
                  <span style={key}>method</span>:{" "}
                  <span style={str}>&quot;POST&quot;</span>
                  <span style={dim}>,</span>{" "}
                  <span style={key}>path</span>:{" "}
                  <span style={str}>&quot;/notify&quot;</span>
                  <span style={dim}>,</span>
                </div>
                <div className="-mx-4 bg-emerald-500/10 px-4">
                  {"    "}
                  <span style={key}>body</span>:{" "}
                  <span style={kw}>jsonStringify</span>
                  <span style={dim}>({"{"}</span>{" "}
                  <span style={key}>sent</span>: orderId{" "}
                  <span style={dim}>{"}"})</span>
                </div>
                <div>
                  {"  "}
                  <span style={dim}>{"}"})</span>
                </div>
                <div>
                  {"  "}
                  <span style={kw}>return</span> res.status
                </div>
                <div>
                  <span style={dim}>{"}"}</span>
                </div>
              </CodeBlock>

              <div className="border border-emerald-500/40 bg-emerald-500/5 p-4 font-mono text-xs leading-relaxed">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-semibold text-emerald-500 uppercase">
                    Static signature
                  </span>
                  <span className="text-emerald-500">
                    violations: []
                  </span>
                </div>
                <div className="text-muted-foreground">
                  <span style={str}>host:api.resend.com</span>{" "}
                  <span style={dim}>&larr;</span>{" "}
                  <span style={kw}>param:apiKey</span>,{" "}
                  <span style={kw}>param:orderId</span>
                </div>
                <div className="text-muted-foreground">
                  <span style={str}>host:hooks.slack.com</span>{" "}
                  <span style={dim}>&larr;</span>{" "}
                  <span style={kw}>param:orderId</span>
                </div>
                <div className="mt-2.5 border-t border-emerald-500/20 pt-2.5 font-sans text-xs text-foreground">
                  <span className="font-mono font-semibold text-emerald-500">
                    Approved.
                  </span>{" "}
                  <code className="font-mono text-[11px]">apiKey</code> only
                  reaches{" "}
                  <code className="font-mono text-[11px]">api.resend.com</code>.
                  Runs directly in-process.
                </div>
              </div>
            </div>

            {/* BREAK example */}
            <div className="flex flex-col gap-3">
              <CodeBlock title="break.ss" badge="fail · 1 violation" tone="fail">
                <div>
                  sendReceipt = <span style={dim}>(</span>orderId:{" "}
                  <span style={warn}>string</span>
                  <span style={dim}>,</span> apiKey:{" "}
                  <span style={warn}>string</span>
                  <span style={dim}>) =&gt; {"{"}</span>
                </div>
                <div>
                  {"  "}res = <span style={kw}>httpRequest</span>
                  <span style={dim}>({"{"}</span>
                </div>
                <div>
                  {"    "}
                  <span style={key}>host</span>:{" "}
                  <span style={str}>&quot;api.resend.com&quot;</span>
                  <span style={dim}>,</span>
                </div>
                <div>
                  {"    "}
                  <span style={key}>method</span>:{" "}
                  <span style={str}>&quot;POST&quot;</span>
                  <span style={dim}>,</span>{" "}
                  <span style={key}>path</span>:{" "}
                  <span style={str}>&quot;/emails&quot;</span>
                  <span style={dim}>,</span>
                </div>
                <div>
                  {"    "}
                  <span style={key}>headers</span>:{" "}
                  <span style={dim}>{"{"}</span>{" "}
                  <span style={key}>authorization</span>:{" "}
                  <span style={str}>`Bearer ${"{"}apiKey{"}"}`</span>{" "}
                  <span style={dim}>{"}"},</span>
                </div>
                <div>
                  {"    "}
                  <span style={key}>body</span>:{" "}
                  <span style={kw}>jsonStringify</span>
                  <span style={dim}>({"{"}</span> orderId{" "}
                  <span style={dim}>{"}"})</span>
                </div>
                <div>
                  {"  "}
                  <span style={dim}>{"}"})</span>
                </div>
                <div>
                  {"  "}
                  <span style={kw}>httpRequest</span>
                  <span style={dim}>({"{"}</span>
                </div>
                <div>
                  {"    "}
                  <span style={key}>host</span>:{" "}
                  <span style={str}>&quot;hooks.slack.com&quot;</span>
                  <span style={dim}>,</span>
                </div>
                <div>
                  {"    "}
                  <span style={key}>method</span>:{" "}
                  <span style={str}>&quot;POST&quot;</span>
                  <span style={dim}>,</span>{" "}
                  <span style={key}>path</span>:{" "}
                  <span style={str}>&quot;/notify&quot;</span>
                  <span style={dim}>,</span>
                </div>
                <div className="-mx-4 bg-red-500/15 px-4">
                  {"    "}
                  <span style={key}>body</span>:{" "}
                  <span style={kw}>jsonStringify</span>
                  <span style={dim}>({"{"}</span>{" "}
                  <span style={key}>sent</span>: orderId
                  <span style={dim}>,</span> <span style={red}>key: apiKey</span>{" "}
                  <span style={dim}>{"}"})</span>
                </div>
                <div>
                  {"  "}
                  <span style={dim}>{"}"})</span>
                </div>
                <div>
                  {"  "}
                  <span style={kw}>return</span> res.status
                </div>
                <div>
                  <span style={dim}>{"}"}</span>
                </div>
              </CodeBlock>

              <div className="border border-red-500/40 bg-red-500/5 p-4 font-mono text-xs leading-relaxed">
                <div className="mb-2 flex items-center justify-between">
                  <span
                    className="font-semibold uppercase"
                    style={{ color: "var(--sig-red)" }}
                  >
                    Static signature
                  </span>
                  <span style={{ color: "var(--sig-red)" }}>
                    kind: &quot;hosts&quot;
                  </span>
                </div>
                <div className="text-muted-foreground">
                  <span style={str}>host:api.resend.com</span>{" "}
                  <span style={dim}>&larr;</span>{" "}
                  <span style={kw}>param:apiKey</span>,{" "}
                  <span style={kw}>param:orderId</span>
                </div>
                <div className="text-muted-foreground">
                  <span style={red}>host:hooks.slack.com</span>{" "}
                  <span style={dim}>&larr;</span>{" "}
                  <span style={kw}>param:orderId</span>,{" "}
                  <span style={red}>param:apiKey</span>
                </div>
                <div className="mt-2.5 border-t border-red-500/20 pt-2.5 font-sans text-xs text-foreground">
                  <span
                    className="font-mono font-semibold"
                    style={{ color: "var(--sig-red)" }}
                  >
                    Rejected before execution.
                  </span>{" "}
                  <code className="font-mono text-[11px]">allowed</code>:{" "}
                  <code className="font-mono text-[11px]">
                    {"{ \"api.resend.com\" }"}
                  </code>
                  , <code className="font-mono text-[11px]">requested</code>:{" "}
                  <code className="font-mono text-[11px]">
                    {"{ \"hooks.slack.com\" }"}
                  </code>
                  . Zero HTTP requests sent.
                </div>
              </div>
            </div>
          </div>

          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            A domain allowlist like{" "}
            <code className="bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              --allow-net=api.resend.com,hooks.slack.com
            </code>{" "}
            lets both scripts through. Because safescript tracks data flow per
            host,{" "}
            <code className="bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              orderId
            </code>{" "}
            can go to Slack while{" "}
            <code className="bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              apiKey
            </code>{" "}
            cannot. Hiding the leak in a helper function or an untaken{" "}
            <code className="bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              if
            </code>{" "}
            branch still fails the check.
          </p>
        </div>
      </div>
    </div>
  </section>
);

const ProblemSection = () => (
  <section className="border-b border-border">
    <div className="mx-auto max-w-5xl px-6 py-16 sm:px-8 sm:py-24 lg:px-12">
      <div className="flex flex-col gap-10">
        <div className="flex flex-col gap-4">
          <h2 className="font-mono text-2xl font-bold tracking-tight sm:text-3xl">
            Why this exists
          </h2>
          <p className="max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            Agents need to run code to be useful, and running untrusted code
            exposes your system to three real failure modes.
          </p>
        </div>

        {/* Attack vectors */}
        <div className="grid gap-6 md:grid-cols-3">
          {/* Vector 01: Traditional Supply chain */}
          <div className="flex flex-col justify-between rounded-none border border-border bg-card/40 p-6 transition-colors hover:border-border/80">
            <div>
              <div className="mb-4 flex items-center justify-between">
                <span
                  className="font-mono text-xs font-semibold tracking-wider uppercase"
                  style={{ color: "var(--sig-red)" }}
                >
                  Vector 01
                </span>
                <span className="border border-border/80 bg-muted/30 px-2 py-0.5 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
                  Supply chain
                </span>
              </div>
              <h3 className="mb-3 font-mono text-lg font-bold tracking-tight text-foreground">
                Package dependencies
              </h3>
              <p className="text-base leading-snug font-medium text-foreground/90">
                Thousands of unvetted dependencies run in-process with full
                access. One poisoned update compromises everything.
              </p>
            </div>
            <details className="group mt-6 overflow-hidden rounded-none border border-border bg-muted/20 transition-all">
              <summary className="flex cursor-pointer select-none items-center justify-between gap-2 px-3 py-2 font-mono text-xs transition-colors hover:bg-muted/40 group-open:border-b group-open:border-border group-open:bg-muted/30 list-none [&::-webkit-details-marker]:hidden">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: "var(--sig-red)" }}
                  />
                  <span className="shrink-0 font-semibold text-foreground">
                    Incident:
                  </span>
                  <span className="truncate text-muted-foreground">
                    event-stream
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                  <span className="font-mono text-[11px] opacity-75">
                    Nov 2018
                  </span>
                  <ChevronDown className="size-3.5 transition-transform duration-200 group-open:rotate-180" />
                </div>
              </summary>
              <div className="bg-background/50 p-3.5 text-xs leading-relaxed text-muted-foreground">
                A popular npm package was transferred to a new maintainer who
                injected{" "}
                <code className="bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
                  flatmap-stream
                </code>{" "}
                to steal private keys from Bitcoin wallets and exfiltrate them to
                a remote server.
              </div>
            </details>
          </div>

          {/* Vector 02: Prompt injections */}
          <div className="flex flex-col justify-between rounded-none border border-border bg-card/40 p-6 transition-colors hover:border-border/80">
            <div>
              <div className="mb-4 flex items-center justify-between">
                <span
                  className="font-mono text-xs font-semibold tracking-wider uppercase"
                  style={{ color: "var(--sig-red)" }}
                >
                  Vector 02
                </span>
                <span className="border border-border/80 bg-muted/30 px-2 py-0.5 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
                  Adversarial input
                </span>
              </div>
              <h3 className="mb-3 font-mono text-lg font-bold tracking-tight text-foreground">
                Prompt injections
              </h3>
              <p className="text-base leading-snug font-medium text-foreground/90">
                Untrusted text from emails, web pages, or user input can hijack
                the model into generating malicious code.
              </p>
            </div>
            <details className="group mt-6 overflow-hidden rounded-none border border-border bg-muted/20 transition-all">
              <summary className="flex cursor-pointer select-none items-center justify-between gap-2 px-3 py-2 font-mono text-xs transition-colors hover:bg-muted/40 group-open:border-b group-open:border-border group-open:bg-muted/30 list-none [&::-webkit-details-marker]:hidden">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: "var(--sig-red)" }}
                  />
                  <span className="shrink-0 font-semibold text-foreground">
                    Incident:
                  </span>
                  <span className="truncate text-muted-foreground">
                    Bing Chat
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                  <span className="font-mono text-[11px] opacity-75">
                    Mar 2023
                  </span>
                  <ChevronDown className="size-3.5 transition-transform duration-200 group-open:rotate-180" />
                </div>
              </summary>
              <div className="bg-background/50 p-3.5 text-xs leading-relaxed text-muted-foreground">
                Security researchers placed hidden text on public web pages. When
                the AI summarized the page, the payload hijacked the assistant
                to access private chat sessions and exfiltrate them.
              </div>
            </details>
          </div>

          {/* Vector 03: Agent skills */}
          <div className="flex flex-col justify-between rounded-none border border-border bg-card/40 p-6 transition-colors hover:border-border/80">
            <div>
              <div className="mb-4 flex items-center justify-between">
                <span
                  className="font-mono text-xs font-semibold tracking-wider uppercase"
                  style={{ color: "var(--sig-red)" }}
                >
                  Vector 03
                </span>
                <span className="border border-border/80 bg-muted/30 px-2 py-0.5 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
                  Hybrid threat
                </span>
              </div>
              <h3 className="mb-3 font-mono text-lg font-bold tracking-tight text-foreground">
                Agent skills
              </h3>
              <p className="text-base leading-snug font-medium text-foreground/90">
                Third-party skills bundle executable scripts with prompts that
                can steer the agent and siphon credentials.
              </p>
            </div>
            <details className="group mt-6 overflow-hidden rounded-none border border-border bg-muted/20 transition-all">
              <summary className="flex cursor-pointer select-none items-center justify-between gap-2 px-3 py-2 font-mono text-xs transition-colors hover:bg-muted/40 group-open:border-b group-open:border-border group-open:bg-muted/30 list-none [&::-webkit-details-marker]:hidden">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: "var(--sig-red)" }}
                  />
                  <span className="shrink-0 font-semibold text-foreground">
                    Incident:
                  </span>
                  <span className="truncate text-muted-foreground">
                    ChatGPT Plugins
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                  <span className="font-mono text-[11px] opacity-75">
                    May 2023
                  </span>
                  <ChevronDown className="size-3.5 transition-transform duration-200 group-open:rotate-180" />
                </div>
              </summary>
              <div className="bg-background/50 p-3.5 text-xs leading-relaxed text-muted-foreground">
                Researchers demonstrated how third-party plugins in OpenAI&apos;s
                ecosystem could combine deceptive instructions with malicious
                endpoints to intercept user tokens and conversation logs.
              </div>
            </details>
          </div>
        </div>

        {/* The Solution */}
        <div className="rounded-none border-2 border-emerald-500/50 bg-emerald-500/5 p-6 sm:p-8">
          <div className="mb-3">
            <span className="font-mono text-xs font-semibold tracking-wider text-emerald-500 uppercase">
              Decouple policy from code
            </span>
          </div>
          <p className="text-xl font-medium tracking-tight text-foreground sm:text-2xl">
            Never review the code. Review the policy.
          </p>
          <p className="mt-3 text-base leading-relaxed text-muted-foreground">
            The compiler proves every host contacted, every environment read,
            and every data flow path before execution. If an attack violates
            your policy, it gets rejected before a single operation runs.
          </p>
        </div>
      </div>
    </div>
  </section>
);

const InstallSection = () => (
  <section className="border-b border-border">
    <div className="mx-auto max-w-5xl px-6 py-12 sm:px-8 sm:py-16 lg:px-12">
      <div className="flex flex-col gap-6">
        <h2 className="font-mono text-sm font-semibold tracking-wide uppercase">
          Install &amp; Agent Onboarding
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <CodeBlock title="CLI (macOS / Linux)">
            <span style={dim}>$</span> curl -fsSL{" "}
            <span style={str}>
              https://raw.githubusercontent.com/uriva/safescript/main/install.sh
            </span>{" "}
            | sh
          </CodeBlock>
          <CodeBlock title="Give to Any AI Agent (Zero Setup)">
            Read{" "}
            <span style={str}>https://safescript.cc/llms.txt</span> before
            writing <span style={kw}>.ss</span> scripts
          </CodeBlock>
          <CodeBlock title="Deno">
            <span style={dim}>$</span> deno add jsr:
            <span style={str}>@uri/safescript</span>
          </CodeBlock>
          <CodeBlock title="npm">
            <span style={dim}>$</span> npx jsr add{" "}
            <span style={str}>@uri/safescript</span>
          </CodeBlock>
        </div>
      </div>
    </div>
  </section>
);

const SandboxComparison = () => (
  <section className="border-b border-border">
    <div className="mx-auto max-w-5xl px-6 py-16 sm:px-8 sm:py-24 lg:px-12">
      <div className="flex flex-col gap-10">
        <div className="flex flex-col gap-4">
          <h2 className="font-mono text-2xl font-bold tracking-tight sm:text-3xl">
            Isn&apos;t a sandbox enough?
          </h2>
          <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
            The standard answer to running untrusted code is &quot;put it in a
            sandbox.&quot; Every approach has real tradeoffs. Here&apos;s what
            the landscape actually looks like.
          </p>
        </div>

        {/* Comparison cards */}
        <div className="flex flex-col gap-6">
          {/* Docker / Containers */}
          <div className="rounded-none border border-border p-6">
            <div className="mb-3 flex items-center gap-3">
              <span className="font-mono text-xs font-semibold tracking-wider text-emerald-500 uppercase">
                Containers
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                Docker, AWS Lambda, etc.
              </span>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Cold starts range from 500ms to 10 seconds. A bare Node.js process
              in Lambda uses ~35MB before your code even loads. Each container
              gets its own OS process, so context switching eats CPU time that
              should go to your code. AWS Lambda can only handle one concurrent
              request per instance, so every new request risks another cold
              start. You&apos;re paying for infrastructure overhead, not
              computation.
            </p>
          </div>

          {/* Firecracker / microVMs */}
          <div className="rounded-none border border-border p-6">
            <div className="mb-3 flex items-center gap-3">
              <span className="font-mono text-xs font-semibold tracking-wider text-emerald-500 uppercase">
                microVMs
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                Firecracker, E2B, Deno Sandbox
              </span>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Lighter than full containers. Firecracker boots a VM in ~125ms
              with about 5MB overhead. That&apos;s much better than Docker, but
              you&apos;re still spinning up a Linux kernel for every sandbox.
              E2B and Deno Sandbox both use microVMs under the hood. For AI
              agents that might run hundreds of code snippets per session, the
              latency compounds. These are designed for workloads that run for
              minutes, not for evaluating a small script in microseconds.
            </p>
          </div>

          {/* V8 Isolates */}
          <div className="rounded-none border border-border p-6">
            <div className="mb-3 flex items-center gap-3">
              <span className="font-mono text-xs font-semibold tracking-wider text-emerald-500 uppercase">
                V8 Isolates
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                Cloudflare Workers, Dynamic Workers
              </span>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              The best runtime sandbox available today. ~5ms startup, ~3MB
              memory. Cloudflare calls them 100x faster than containers. The
              catch: you need their platform to run them. V8 isolates are not
              something you can trivially embed in your own application. And
              they&apos;re still a runtime boundary. You control what APIs the
              code can call, but you can&apos;t see what the code{" "}
              <em className="font-medium text-foreground not-italic">
                will do
              </em>{" "}
              before it runs. A compromised dependency inside an isolate can
              still exfiltrate data through any API you&apos;ve exposed to it.
            </p>
          </div>

          {/* Deno Permissions */}
          <div className="rounded-none border border-border p-6">
            <div className="mb-3 flex items-center gap-3">
              <span className="font-mono text-xs font-semibold tracking-wider text-emerald-500 uppercase">
                Deno Permissions
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                --allow-net, --allow-read, etc.
              </span>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Process-level flags that restrict I/O at the runtime boundary.
              Better than Node&apos;s &quot;everything is allowed&quot; default.
              But all code on the same thread shares the same privilege level.
              If you grant network access to call one API, every dependency can
              use that access too. <code className="text-xs">eval()</code>{" "}
              and dynamic imports run at full privilege. Deno&apos;s own docs
              recommend using additional sandboxing (VMs, seccomp, cgroups) for
              truly untrusted code. Permissions tell you what the process{" "}
              <em className="font-medium text-foreground not-italic">can</em>
              {" "}
              do, not what it{" "}
              <em className="font-medium text-foreground not-italic">will</em>
              {" "}
              do.
            </p>
          </div>

          {/* JS Sandboxes */}
          <div className="rounded-none border border-border p-6">
            <div className="mb-3 flex items-center gap-3">
              <span className="font-mono text-xs font-semibold tracking-wider text-emerald-500 uppercase">
                JS Sandboxes
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                isolated-vm, quickjs-emscripten, SandboxJS
              </span>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              In-process sandboxing. Isolated-vm runs V8 isolates inside Node
              but has had sandbox escape CVEs. QuickJS-emscripten compiles the
              QuickJS engine to WASM, which gives real memory isolation at ~2MB
              overhead, but no native async and a limited standard library.
              SandboxJS-style libraries just wrap eval with property hiding on
              the global object, which is trivially escapable. The lightweight
              options aren&apos;t hermetic. The hermetic options aren&apos;t
              lightweight.
            </p>
          </div>

          {/* Wasm */}
          <div className="rounded-none border border-border p-6">
            <div className="mb-3 flex items-center gap-3">
              <span className="font-mono text-xs font-semibold tracking-wider text-emerald-500 uppercase">
                WebAssembly
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                Wasm sandboxing, WASI
              </span>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Memory-safe by design: linear memory, no raw pointers, no I/O
              unless the host provides it. Good security properties. But Wasm
              modules need explicit host bindings for everything, including
              basic things like printing or network access. Compilation adds
              latency. No native async. Debugging is painful. It&apos;s an
              execution format, not a language, so you still need a toolchain to
              compile code into it. Good for plugin systems, awkward for running
              arbitrary agent-generated scripts.
            </p>
          </div>
        </div>

        {/* The safescript alternative */}
        <div className="rounded-none border-2 border-emerald-500/50 bg-emerald-500/5 p-6">
          <div className="mb-3">
            <span className="font-mono text-xs font-semibold tracking-wider text-emerald-500 uppercase">
              safescript&apos;s approach
            </span>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Every approach above tries to restrict what code{" "}
            <em className="font-medium text-foreground not-italic">
              can do at runtime
            </em>. Safescript restricts what code{" "}
            <em className="font-medium text-foreground not-italic">
              can express at all
            </em>. The compiler proves every security property statically,
            before any execution. You know exactly which hosts will be
            contacted, which secrets will be read, and how data flows between
            them. No sandbox needed because the dangerous operations simply
            aren&apos;t there. Zero overhead. Zero cold start. Zero escape
            surface. Just call a function in your own process.
          </p>
        </div>

        {/* Summary table */}
        <div className="overflow-x-auto rounded-none border border-border">
          <table className="w-full text-left font-mono text-xs">
            <thead>
              <tr
                className="border-b border-border"
                style={{ background: "var(--sig-bar-bg)" }}
              >
                <th className="px-4 py-3 font-semibold">Approach</th>
                <th className="px-4 py-3 font-semibold">Cold start</th>
                <th className="px-4 py-3 font-semibold">Memory</th>
                <th className="px-4 py-3 font-semibold">Hermetic</th>
              </tr>
            </thead>
            <tbody
              className="divide-y divide-border"
              style={{ background: "var(--sig-bg)" }}
            >
              <tr>
                <td className="px-4 py-3">Containers</td>
                <td className="px-4 py-3 text-red-500">500ms–10s</td>
                <td className="px-4 py-3 text-red-500">~35MB+</td>
                <td className="px-4 py-3 text-yellow-500">partial</td>
              </tr>
              <tr>
                <td className="px-4 py-3">microVMs</td>
                <td className="px-4 py-3 text-yellow-500">~125ms</td>
                <td className="px-4 py-3 text-yellow-500">~5MB+</td>
                <td className="px-4 py-3 text-emerald-500">yes</td>
              </tr>
              <tr>
                <td className="px-4 py-3">V8 Isolates</td>
                <td className="px-4 py-3 text-emerald-500">~5ms</td>
                <td className="px-4 py-3 text-emerald-500">~3MB</td>
                <td className="px-4 py-3 text-yellow-500">runtime only</td>
              </tr>
              <tr>
                <td className="px-4 py-3">Deno perms</td>
                <td className="px-4 py-3 text-emerald-500">0</td>
                <td className="px-4 py-3 text-emerald-500">0</td>
                <td className="px-4 py-3 text-red-500">no</td>
              </tr>
              <tr>
                <td className="px-4 py-3">JS sandboxes</td>
                <td className="px-4 py-3 text-emerald-500">&lt;1ms</td>
                <td className="px-4 py-3 text-emerald-500">~2MB</td>
                <td className="px-4 py-3 text-red-500">varies</td>
              </tr>
              <tr>
                <td className="px-4 py-3">Wasm</td>
                <td className="px-4 py-3 text-yellow-500">~10ms</td>
                <td className="px-4 py-3 text-emerald-500">~2MB</td>
                <td className="px-4 py-3 text-emerald-500">yes</td>
              </tr>
              <tr className="bg-emerald-500/5">
                <td className="px-4 py-3 font-semibold text-emerald-500">
                  safescript
                </td>
                <td className="px-4 py-3 font-semibold text-emerald-500">0</td>
                <td className="px-4 py-3 font-semibold text-emerald-500">0</td>
                <td className="px-4 py-3 font-semibold text-emerald-500">
                  static proof
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
);

const SafeAppSection = () => (
  <section className="border-b border-border bg-emerald-500/[0.02]">
    <div className="mx-auto max-w-5xl px-6 py-16 sm:px-8 sm:py-24 lg:px-12">
      <div className="rounded-none border-2 border-emerald-500/40 bg-card/50 p-6 sm:p-10">
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="font-mono text-xs font-semibold tracking-wider text-emerald-500 uppercase">
              Hosted Full-Stack Runtime &middot; Built on SafeScript
            </span>
            <span className="border border-border bg-muted/40 px-2.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              app.safescript.cc
            </span>
          </div>

          <div className="flex flex-col gap-3">
            <h2 className="font-mono text-2xl font-bold tracking-tight sm:text-3xl">
              Want agents to ship full web apps without code review?
            </h2>
            <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
              <strong className="font-semibold text-foreground">SafeApp</strong>{" "}
              turns SafeScript&apos;s static proofs into an instant full-stack
              platform. Agents deploy dashboards, internal tools, SQLite tables,
              and webhook pipelines in ~50ms, with compile-time proof that data
              and secrets never leak where they shouldn&apos;t. Try it without
              signing in.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="border border-border bg-background/60 p-4">
              <div className="font-mono text-sm font-semibold text-emerald-500">
                ~50ms Edge Deploy
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                POST raw Safescript straight to a live preview URL with no
                sign-in, build steps, or container spin-up.
              </p>
            </div>
            <div className="border border-border bg-background/60 p-4">
              <div className="font-mono text-sm font-semibold text-emerald-500">
                Batteries Included
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                SQLite namespaces, scheduled cron jobs, KV, durable queues,
                branch previews, and email magic-code login out of the box.
              </p>
            </div>
            <div className="border border-border bg-background/60 p-4">
              <div className="font-mono text-sm font-semibold text-emerald-500">
                Provably Leak-Free
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Secrets stay pinned to approved hosts; database rows only reach
                permitted endpoints; tenant rules hold automatically.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <a
              href="https://app.safescript.cc"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-10 items-center gap-2 rounded-none border border-emerald-500 bg-emerald-500 px-5 font-mono text-xs font-semibold text-slate-950 transition-colors hover:bg-emerald-400"
            >
              Try SafeApp without signing in &nearr;
            </a>
            <a
              href="https://app.safescript.cc/llms.txt"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-10 items-center gap-2 rounded-none border border-border bg-background px-5 font-mono text-xs transition-colors hover:bg-muted"
            >
              SafeApp Agent Spec (/llms.txt)
            </a>
          </div>
        </div>
      </div>
    </div>
  </section>
);

const Page = () => {
  const readmeContent = getReadmeContent();
  const version = getVersion();

  return (
    <div className="flex min-h-full flex-col">
      {/* Nav */}
      <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6 sm:px-8 lg:px-12">
          <a href="/" className="font-mono text-sm font-bold tracking-tight">
            safe<span className="text-emerald-500">script</span>
          </a>
          <nav className="flex items-center gap-1">
            <a
              href="#docs"
              className="rounded-none px-3 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Docs
            </a>
            <a
              href="/skills"
              className="rounded-none px-3 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Skills
            </a>
            <a
              href="/llms.txt"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden rounded-none px-3 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground sm:inline-block"
            >
              llms.txt
            </a>
            <a
              href="https://app.safescript.cc"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-none px-3 py-1.5 font-mono text-xs text-emerald-500 transition-colors hover:text-emerald-400"
            >
              SafeApp &nearr;
            </a>
            <a
              href="https://github.com/uriva/safescript"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-none px-3 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              GitHub
            </a>
            <ThemeToggle />
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <HeroSection version={version} />
        <LanguageShowcase />
        <InstallSection />
        <ProblemSection />
        <SandboxComparison />
        <SafeAppSection />

        {/* Docs section */}
        <section id="docs" className="scroll-mt-14">
          <div className="mx-auto max-w-6xl px-6 py-16 sm:px-8 sm:py-24 lg:px-12">
            <div className="mb-12 flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
                Documentation
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>
            <div className="flex gap-10">
              <DocsToc content={readmeContent} />
              <div className="min-w-0 max-w-3xl flex-1">
                <MarkdownContent content={readmeContent} />
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6 sm:px-8 lg:px-12">
          <span className="font-mono text-xs text-muted-foreground">
            safescript &middot;{" "}
            <a
              href="https://app.safescript.cc"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-emerald-500"
            >
              SafeApp
            </a>
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            MIT License
          </span>
        </div>
      </footer>
    </div>
  );
};

export { Page as default };
