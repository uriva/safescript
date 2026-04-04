import fs from "node:fs";
import path from "node:path";
import * as React from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { MarkdownContent } from "@/components/markdown-content";
import { Shield, GitBranch, Eye } from "lucide-react";

const getReadmeContent = () => {
  const readmePath = path.join(process.cwd(), "..", "README.md");
  return fs.readFileSync(readmePath, "utf-8");
};

const features = [
  {
    icon: Shield,
    title: "Provably safe",
    description:
      "Every program is a static DAG. No eval, no imports, no infinite loops. The set of things a program can do is fully knowable before it runs.",
  },
  {
    icon: Eye,
    title: "Full visibility",
    description:
      "Signatures capture every secret read, every host contacted, and every data flow path. Diff them between versions to catch supply chain attacks automatically.",
  },
  {
    icon: GitBranch,
    title: "Real language",
    description:
      "Variables, expressions, control flow, 25+ built-in ops. Not a config format. Not a toy. A language constrained enough to be formally analyzed.",
  },
];

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
          <span className="ml-4 inline-block text-4xl sm:text-5xl lg:text-6xl">😌</span>
        </h1>

        {/* Subtitle */}
        <p className="max-w-2xl text-xl leading-relaxed text-muted-foreground sm:text-2xl">
          A programming language for AI agents. Static DAGs, closed instruction
          sets, and formal data-flow tracking you can inspect before anything
          runs.
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

        {/* Signature preview */}
        <div className="mt-4 max-w-2xl overflow-hidden rounded-none border border-border shadow-2xl">
          <div className="flex items-center gap-2 border-b border-[#30363d] bg-[#161b22] px-4 py-2">
            <span className="size-2 rounded-full bg-emerald-500" />
            <span className="font-mono text-xs text-[#8b949e]">
              signature output
            </span>
          </div>
          <pre className="overflow-x-auto bg-[#0d1117] p-4 font-mono text-xs leading-relaxed text-[#c9d1d9] sm:text-sm">
            <code>
              <div><span className="text-[#79c0ff]">secretsRead:</span>    <span className="text-[#8b949e]">{"{"}</span> <span className="text-[#a5d6ff]">"api-token"</span> <span className="text-[#8b949e]">{"}"}</span></div>
              <div><span className="text-[#79c0ff]">hosts:</span>          <span className="text-[#8b949e]">{"{"}</span> <span className="text-[#a5d6ff]">"api.example.com"</span> <span className="text-[#8b949e]">{"}"}</span></div>
              <div><span className="text-[#79c0ff]">accesses:</span>       <span className="text-[#8b949e]">{"{"}</span> <span className="text-[#ff7b72]">time</span>, <span className="text-[#ff7b72]">random</span> <span className="text-[#8b949e]">{"}"}</span></div>
              <div><span className="text-[#79c0ff]">llmInput:</span>       <span className="text-[#8b949e]">{"{"}</span> <span className="text-[#d2a8ff]">param:query</span>, <span className="text-[#a5d6ff]">host:api.example.com</span> <span className="text-[#8b949e]">{"}"}</span></div>
              <div><span className="text-[#79c0ff]">llmOutputTypes:</span> <span className="text-[#8b949e]">{"{"}</span> <span className="text-[#d2a8ff]">"summary"</span>, <span className="text-[#d2a8ff]">"action_items"</span> <span className="text-[#8b949e]">{"}"}</span></div>
              <div><span className="text-[#79c0ff]">dataFlow:</span></div>
              <div>  <span className="text-[#d2a8ff]">param:userId</span>        <span className="text-[#8b949e]">→</span> <span className="text-[#a5d6ff]">host:api.example.com</span></div>
              <div>  <span className="text-[#ff7b72] font-semibold">secret:api-token</span>    <span className="text-[#8b949e]">→</span> <span className="text-[#a5d6ff]">host:api.example.com</span> <span className="text-[#ffa657] italic sm:ml-4 ml-2">// ⚠️ exposes secret to host</span></div>
              <div><span className="text-[#79c0ff]">memoryBytes:</span>    <span className="text-[#79c0ff]">1,002,048</span></div>
              <div><span className="text-[#79c0ff]">runtimeMs:</span>      <span className="text-[#79c0ff]">10,020</span></div>
            </code>
          </pre>
        </div>
      </div>
    </div>
  </section>
);

const FeatureCards = () => (
  <section className="border-b border-border">
    <div className="mx-auto grid max-w-6xl gap-0 sm:grid-cols-3">
      {features.map((feature, i) => (
        <div
          key={feature.title}
          className={`flex flex-col gap-4 border-border p-8 sm:p-10 ${
            i < features.length - 1 ? "border-b sm:border-b-0 sm:border-r" : ""
          }`}
        >
          <feature.icon className="size-5 text-emerald-500" strokeWidth={1.5} />
          <h3 className="font-mono text-sm font-semibold tracking-wide uppercase">
            {feature.title}
          </h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {feature.description}
          </p>
        </div>
      ))}
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
        <FeatureCards />

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
