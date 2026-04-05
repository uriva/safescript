import fs from "node:fs";
import path from "node:path";
import * as React from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { MarkdownContent } from "@/components/markdown-content";

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
              <span style={dim}>({"{"}</span> <span style={key}>name</span>:{" "}
              <span style={str}>&quot;api-key&quot;</span>{" "}
              <span style={dim}>{"}"})</span>
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

        {/* Step 2: The signature */}
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs text-emerald-500">02</span>
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
            Computed statically from the source. No execution needed. Every
            secret read, every host contacted, every data flow path. You know
            everything before it runs, so you can run it in-process. No
            container, no VM, no cold start. Just call a function.
          </p>
        </div>

        {/* Step 3: Imports */}
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs text-emerald-500">03</span>
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
              <span style={kw}>perms</span> <span style={dim}>{"{"}</span>{" "}
              <span style={key}>hosts</span>: [
              <span style={str}>&quot;api.example.com&quot;</span>],{" "}
              <span style={key}>secretsRead</span>: [
              <span style={str}>&quot;api-key&quot;</span>]{" "}
              <span style={dim}>{"}"}</span>
            </div>
            <div>
              {"  "}
              <span style={kw}>hash</span>{" "}
              <span style={dim}>
                &quot;sha256:9f86d081884c...&quot;
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
            source. The perms assert its signature. New host or secret read?
            Build fails. Code changed? Hash fails. Supply chain attacks become
            build errors.
          </p>
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
        <Walkthrough />

        {/* Docs section */}
        <section id="docs" className="scroll-mt-14">
          <div className="mx-auto max-w-4xl px-6 py-16 sm:px-8 sm:py-24 lg:px-12">
            <div className="mb-12 flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
                Documentation
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>
            <MarkdownContent content={readmeContent} />
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
