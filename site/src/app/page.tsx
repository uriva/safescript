import fs from "node:fs";
import path from "node:path";
import * as React from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { MarkdownContent } from "@/components/markdown-content";
import { DocsToc } from "@/components/docs-toc";

const getReadmeContent = () => {
  const readmePath = path.join(process.cwd(), "..", "README.md");
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
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <div className="overflow-hidden rounded-none border border-border">
    <div
      className="flex items-center gap-2 border-b border-border px-4 py-2"
      style={{ background: "var(--sig-bar-bg)" }}
    >
      <span className="size-2 rounded-full bg-emerald-500" />
      <span className="font-mono text-xs text-muted-foreground">{title}</span>
    </div>
    <pre
      className="overflow-x-auto p-4 font-mono text-xs leading-relaxed sm:text-sm"
      style={{ background: "var(--sig-bg)", color: "var(--sig-text)" }}
    >
      <code>{children}</code>
    </pre>
  </div>
);

const HeroSection = () => (
  <section className="relative overflow-hidden border-b border-border">
    {/* Grid background pattern */}
    <div className="absolute inset-0 bg-[linear-gradient(to_right,var(--color-border)_1px,transparent_1px),linear-gradient(to_bottom,var(--color-border)_1px,transparent_1px)] bg-[size:4rem_4rem] opacity-40" />
    <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-background" />

    <div className="relative mx-auto max-w-6xl px-6 pb-20 pt-32 sm:px-8 lg:px-12">
      <div className="flex flex-col gap-8">
        {/* Badge */}
        <div className="flex">
          <span className="inline-flex items-center gap-2 rounded-none border border-primary/30 bg-primary/5 px-3 py-1.5 font-mono text-xs tracking-wider text-primary uppercase">
            <span className="inline-block size-1.5 rounded-full bg-emerald-500 animate-pulse" />
            v0.1.0
          </span>
        </div>

        {/* Title */}
        <h1 className="font-mono text-5xl font-bold tracking-tight sm:text-6xl lg:text-7xl">
          safe
          <span className="text-emerald-500">script</span>
          <span className="ml-4 inline-block text-4xl sm:text-5xl lg:text-6xl">
            😌
          </span>
        </h1>

        {/* Subtitle */}
        <p className="max-w-2xl text-xl leading-relaxed text-muted-foreground sm:text-2xl">
          A programming language for AI agents. Provably safe. Immune to supply
          chain attacks. Ready to eval, no VM required.
        </p>

        {/* CTA row */}
        <div className="flex flex-wrap items-center gap-4 pt-2">
          <a
            href="#docs"
            className="inline-flex h-11 items-center gap-2 rounded-none border border-primary bg-primary px-6 font-mono text-sm text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Read the docs
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

const InstallSection = () => (
  <section className="border-b border-border">
    <div className="mx-auto max-w-4xl px-6 py-12 sm:px-8 sm:py-16 lg:px-12">
      <div className="flex flex-col gap-6">
        <h2 className="font-mono text-sm font-semibold tracking-wide uppercase">
          Install
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
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

const DagVisualization = () => (
  <div className="overflow-hidden rounded-none border border-border">
    <div
      className="flex items-center gap-2 border-b border-border px-4 py-2"
      style={{ background: "var(--sig-bar-bg)" }}
    >
      <span className="size-2 rounded-full bg-emerald-500" />
      <span className="font-mono text-xs text-muted-foreground">
        data flow graph
      </span>
    </div>
    <div
      className="overflow-x-auto p-4"
      style={{ background: "var(--sig-bg)" }}
    >
      <svg
        viewBox="0 0 680 250"
        className="w-full"
        style={{ maxHeight: 280, minWidth: 480 }}
      >
        <defs>
          {/* Glow filter for animated dots */}
          <filter id="glow-emerald" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="glow-red" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Edge paths */}
          <path id="edge-param" d="M160,51 C225,51 225,110 290,110" fill="none" />
          <path id="edge-secret" d="M190,197 C240,197 240,140 290,140" fill="none" />
          <path id="edge-return" d="M500,125 L580,125" fill="none" />
        </defs>

        {/* ── Edges ── */}
        <use href="#edge-param" stroke="var(--sig-brace)" strokeWidth="1.5" opacity="0.5" />
        <use href="#edge-secret" stroke="var(--sig-red)" strokeWidth="1.5" opacity="0.5" />
        <use href="#edge-return" stroke="var(--sig-brace)" strokeWidth="1.5" opacity="0.5" />

        {/* Arrowheads */}
        <polygon points="288,105 288,115 295,110" fill="var(--sig-brace)" opacity="0.7" />
        <polygon points="288,135 288,145 295,140" fill="var(--sig-red)" opacity="0.7" />
        <polygon points="578,120 578,130 585,125" fill="var(--sig-brace)" opacity="0.7" />

        {/* ── Nodes ── */}
        {/* param:id */}
        <rect x="30" y="28" width="130" height="46" rx="3" fill="none" stroke="var(--sig-brace)" strokeWidth="1" opacity="0.6" />
        <text x="95" y="47" textAnchor="middle" style={{ fill: "var(--sig-purple)", fontSize: 11, fontFamily: "monospace" }}>param</text>
        <text x="95" y="64" textAnchor="middle" style={{ fill: "var(--sig-text)", fontSize: 12, fontFamily: "monospace", fontWeight: 600 }}>id</text>

        {/* secret:api-key */}
        <rect x="20" y="174" width="170" height="46" rx="3" fill="none" stroke="var(--sig-red)" strokeWidth="1.5" opacity="0.8" />
        <text x="105" y="193" textAnchor="middle" style={{ fill: "var(--sig-red)", fontSize: 11, fontFamily: "monospace" }}>secret</text>
        <text x="105" y="210" textAnchor="middle" style={{ fill: "var(--sig-red)", fontSize: 12, fontFamily: "monospace", fontWeight: 600 }}>api-key</text>

        {/* httpRequest */}
        <rect x="290" y="85" width="210" height="80" rx="3" fill="none" stroke="var(--sig-brace)" strokeWidth="1" opacity="0.6" />
        <text x="395" y="118" textAnchor="middle" style={{ fill: "var(--sig-purple)", fontSize: 12, fontFamily: "monospace" }}>httpRequest</text>
        <text x="395" y="148" textAnchor="middle" style={{ fill: "var(--sig-string)", fontSize: 11, fontFamily: "monospace" }}>&quot;api.example.com&quot;</text>

        {/* return */}
        <rect x="580" y="103" width="80" height="44" rx="3" fill="none" stroke="var(--sig-brace)" strokeWidth="1" opacity="0.6" />
        <text x="620" y="130" textAnchor="middle" style={{ fill: "var(--sig-purple)", fontSize: 12, fontFamily: "monospace" }}>return</text>

        {/* ── Animated dots ── */}
        {/* param → httpRequest (emerald) */}
        <g filter="url(#glow-emerald)">
          <circle r="6" fill="#34d399" opacity="0.3">
            <animateMotion dur="2.5s" repeatCount="indefinite">
              <mpath href="#edge-param" />
            </animateMotion>
            <animate attributeName="opacity" values="0;0.4;0.4;0" dur="2.5s" repeatCount="indefinite" />
          </circle>
          <circle r="3" fill="#34d399" opacity="0.9">
            <animateMotion dur="2.5s" repeatCount="indefinite">
              <mpath href="#edge-param" />
            </animateMotion>
            <animate attributeName="opacity" values="0;1;1;0" dur="2.5s" repeatCount="indefinite" />
          </circle>
        </g>

        {/* secret → httpRequest (red, warning) */}
        <g filter="url(#glow-red)">
          <circle r="6" fill="#f87171" opacity="0.3">
            <animateMotion dur="3s" begin="0.5s" repeatCount="indefinite">
              <mpath href="#edge-secret" />
            </animateMotion>
            <animate attributeName="opacity" values="0;0.5;0.5;0" dur="3s" begin="0.5s" repeatCount="indefinite" />
          </circle>
          <circle r="3" fill="#f87171" opacity="0.9">
            <animateMotion dur="3s" begin="0.5s" repeatCount="indefinite">
              <mpath href="#edge-secret" />
            </animateMotion>
            <animate attributeName="opacity" values="0;1;1;0" dur="3s" begin="0.5s" repeatCount="indefinite" />
          </circle>
        </g>

        {/* httpRequest → return (emerald) */}
        <g filter="url(#glow-emerald)">
          <circle r="6" fill="#34d399" opacity="0.3">
            <animateMotion dur="1.5s" begin="1s" repeatCount="indefinite">
              <mpath href="#edge-return" />
            </animateMotion>
            <animate attributeName="opacity" values="0;0.4;0.4;0" dur="1.5s" begin="1s" repeatCount="indefinite" />
          </circle>
          <circle r="3" fill="#34d399" opacity="0.9">
            <animateMotion dur="1.5s" begin="1s" repeatCount="indefinite">
              <mpath href="#edge-return" />
            </animateMotion>
            <animate attributeName="opacity" values="0;1;1;0" dur="1.5s" begin="1s" repeatCount="indefinite" />
          </circle>
        </g>
      </svg>
    </div>
  </div>
);

const Walkthrough = () => (
  <section className="border-b border-border">
    <div className="mx-auto max-w-4xl px-6 py-16 sm:px-8 sm:py-24 lg:px-12">
      <div className="flex flex-col gap-20">
        {/* Step 1: The code */}
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs text-emerald-500">01</span>
            <h2 className="font-mono text-sm font-semibold tracking-wide uppercase">
              Write code
            </h2>
          </div>
          <CodeBlock title="fetch.ss">
            <div>
              fetchUser ={" "}
              <span style={dim}>(</span>id:{" "}
              <span style={warn}>string</span>
              <span style={dim}>)</span> <span style={dim}>{"=>"}</span>{" "}
              <span style={dim}>{"{"}</span>
            </div>
            <div>
              {"  "}key = <span style={kw}>readSecret</span>
              <span style={dim}>(</span>
              <span style={str}>&quot;api-key&quot;</span>
              <span style={dim}>)</span>
            </div>
            <div>
              {"  "}user = <span style={kw}>httpRequest</span>
              <span style={dim}>({"{"}</span>
            </div>
            <div>
              {"    "}
              <span style={key}>host</span>:{" "}
              <span style={str}>&quot;api.example.com&quot;</span>,
            </div>
            <div>
              {"    "}
              <span style={key}>method</span>:{" "}
              <span style={str}>&quot;GET&quot;</span>,
            </div>
            <div>
              {"    "}
              <span style={key}>path</span>:{" "}
              <span style={str}>&quot;/users&quot;</span>,
            </div>
            <div>
              {"    "}
              <span style={key}>headers</span>: key,
            </div>
            <div>
              {"    "}
              <span style={key}>body</span>: id
            </div>
            <div>
              {"  "}
              <span style={dim}>{"}"})</span>
            </div>
            <div>
              {"  "}
              <span style={kw}>return</span> user
            </div>
            <div>
              <span style={dim}>{"}"}</span>
            </div>
          </CodeBlock>
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
            Looks like a normal language. Variables, expressions, function calls.
            One constraint: when your code reads a secret or calls a host, those
            names must be string literals. Not variables. This is what makes
            static analysis possible.
          </p>
        </div>

        {/* Step 2: The DAG */}
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs text-emerald-500">02</span>
            <h2 className="font-mono text-sm font-semibold tracking-wide uppercase">
              See the graph
            </h2>
          </div>
          <DagVisualization />
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
            Every program compiles to a static directed acyclic graph. No dynamic
            dispatch, no runtime surprises. We can trace every piece of data from
            source to sink without executing anything.
          </p>
        </div>

        {/* Step 3: The signature */}
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs text-emerald-500">03</span>
            <h2 className="font-mono text-sm font-semibold tracking-wide uppercase">
              See everything before it runs
            </h2>
          </div>
          <CodeBlock title="signature">
            <div>
              <span style={key}>secretsRead</span>:{" "}
              <span style={dim}>{"{"}</span>{" "}
              <span style={str}>&quot;api-key&quot;</span>{" "}
              <span style={dim}>{"}"}</span>
            </div>
            <div>
              <span style={key}>hosts</span>:{"       "}
              <span style={dim}>{"{"}</span>{" "}
              <span style={str}>&quot;api.example.com&quot;</span>{" "}
              <span style={dim}>{"}"}</span>
            </div>
            <div>
              <span style={key}>dataFlow</span>:
            </div>
            <div>
              {"  "}
              <span style={kw}>param:id</span>
              {"       "}
              <span style={dim}>&rarr;</span>{" "}
              <span style={str}>host:api.example.com</span>
            </div>
            <div>
              {"  "}
              <span className="font-semibold" style={red}>
                secret:api-key
              </span>
              {"  "}
              <span style={dim}>&rarr;</span>{" "}
              <span style={str}>host:api.example.com</span>
              {"  "}
              <span style={warn}>⚠️ secret exposed to host</span>
            </div>
          </CodeBlock>
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
            Computed <em className="font-medium text-foreground not-italic">statically</em> from the source. No execution needed. Every
            secret read, every host contacted, every data flow path. You know
            everything before it runs, so you can run it in-process. No
            container, no VM, no cold start. Just call a function.
          </p>
        </div>

        {/* Step 4: Imports */}
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs text-emerald-500">04</span>
            <h2 className="font-mono text-sm font-semibold tracking-wide uppercase">
              Import without fear
            </h2>
          </div>
          <CodeBlock title="main.ss">
            <div>
              <span style={kw}>import</span> fetchUser{" "}
              <span style={kw}>from</span>{" "}
              <span style={str}>
                &quot;https://example.com/fetch.ss&quot;
              </span>
            </div>
            <div>
              {"  "}
              <span style={kw}>perms</span> <span style={dim}>{"{"}</span>
            </div>
            <div>
              {"    "}
              <span style={key}>hosts</span>: [
              <span style={str}>&quot;api.example.com&quot;</span>],
            </div>
            <div>
              {"    "}
              <span style={key}>secretsRead</span>: [
              <span style={str}>&quot;api-key&quot;</span>],
            </div>
            <div>
              {"    "}
              <span style={key}>dataFlow</span>:{" "}
              <span style={dim}>{"{"}</span>{" "}
              <span style={str}>&quot;host:api.example.com&quot;</span>: [
              <span style={str}>&quot;param:id&quot;</span>,{" "}
              <span style={str}>&quot;secret:api-key&quot;</span>]{" "}
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
                &quot;sha256:9f86d081884c...&quot;
              </span>
              {"  "}
              <span style={dim}>
                // optional, locks a specific version
              </span>
            </div>
            <div />
            <div>
              main ={" "}
              <span style={dim}>(</span>query:{" "}
              <span style={warn}>string</span>
              <span style={dim}>)</span> <span style={dim}>{"=>"}</span>{" "}
              <span style={dim}>{"{"}</span>
            </div>
            <div>
              {"  "}result = fetchUser
              <span style={dim}>({"{"}</span> <span style={key}>id</span>:
              query <span style={dim}>{"}"})</span>
            </div>
            <div>
              {"  "}
              <span style={kw}>return</span> result
            </div>
            <div>
              <span style={dim}>{"}"}</span>
            </div>
          </CodeBlock>
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
            Declare what a dependency is allowed to do. The hash locks the
            source. The perms assert its signature: hosts, secrets, and data
            flows. New host or secret read? Build fails. Secret starts flowing
            somewhere new? Build fails. Code changed? Hash fails. Supply chain
            attacks become build errors.
          </p>
        </div>
      </div>
    </div>
  </section>
);

const SandboxComparison = () => (
  <section className="border-b border-border">
    <div className="mx-auto max-w-4xl px-6 py-16 sm:px-8 sm:py-24 lg:px-12">
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
              E2B and Deno Sandbox both use microVMs under the hood. For
              AI agents that might run hundreds of code snippets per session,
              the latency compounds. These are designed for workloads that run
              for minutes, not for evaluating a small script in microseconds.
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
              code can call, but you can&apos;t see what the code <em className="font-medium text-foreground not-italic">will do</em> before
              it runs. A compromised dependency inside an isolate can still
              exfiltrate data through any API you&apos;ve exposed to it.
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
              use that access too. <code className="text-xs">eval()</code> and
              dynamic imports run at full privilege. Deno&apos;s own docs
              recommend using additional sandboxing (VMs, seccomp, cgroups) for
              truly untrusted code. Permissions tell you what the process{" "}
              <em className="font-medium text-foreground not-italic">can</em> do,
              not what it <em className="font-medium text-foreground not-italic">will</em> do.
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
              execution format, not a language, so you still need a toolchain
              to compile code into it. Good for plugin systems, awkward for
              running arbitrary agent-generated scripts.
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
            <em className="font-medium text-foreground not-italic">can do at runtime</em>.
            Safescript restricts what code{" "}
            <em className="font-medium text-foreground not-italic">can express at all</em>.
            The compiler proves every security property statically, before
            any execution. You know exactly which hosts will be contacted,
            which secrets will be read, and how data flows between them. No
            sandbox needed because the dangerous operations simply
            aren&apos;t there. Zero overhead. Zero cold start. Zero escape
            surface. Just call a function in your own process.
          </p>
        </div>

        {/* Summary table */}
        <div className="overflow-x-auto rounded-none border border-border">
          <table className="w-full text-left font-mono text-xs">
            <thead>
              <tr className="border-b border-border" style={{ background: "var(--sig-bar-bg)" }}>
                <th className="px-4 py-3 font-semibold">Approach</th>
                <th className="px-4 py-3 font-semibold">Cold start</th>
                <th className="px-4 py-3 font-semibold">Memory</th>
                <th className="px-4 py-3 font-semibold">Hermetic</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border" style={{ background: "var(--sig-bg)" }}>
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
                <td className="px-4 py-3 font-semibold text-emerald-500">safescript</td>
                <td className="px-4 py-3 font-semibold text-emerald-500">0</td>
                <td className="px-4 py-3 font-semibold text-emerald-500">0</td>
                <td className="px-4 py-3 font-semibold text-emerald-500">static proof</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
);

const Page = () => {
  const readmeContent = getReadmeContent();

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
        <HeroSection />
        <InstallSection />
        <Walkthrough />
        <SandboxComparison />

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
            safescript
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
