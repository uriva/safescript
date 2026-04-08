import { ThemeToggle } from "@/components/theme-toggle";

const code = {
  sync: `// sync.ss — pull contacts from CRM, write them to your DB

import formatContact from "./format.ss" perms {} hash "sha256:9f2a..."

sync = (apiHost: string, dbHost: string): string => {
  token = readSecret({ name: "crm-token" })
  contacts = httpRequest({
    host: apiHost,
    method: "GET",
    path: "/api/contacts",
    headers: { "authorization": token }
  })
  parsed = jsonParse({ text: contacts })
  formatted = map(formatContact, parsed)
  body = jsonStringify({ value: formatted })
  httpRequest({
    host: dbHost,
    method: "POST",
    path: "/api/bulk-upsert",
    body: body
  })
  count = stringConcat({ parts: ["synced ", body] })
  return count
}`,

  format: `// format.ss — normalize a single CRM contact record

formatContact = (contact: { first: string, last: string, email: string }): { name: string, email: string } => {
  full = stringConcat({ parts: [contact.first, " ", contact.last] })
  return { name: full, email: contact.email }
}`,

  check: `// check.ss — verify the CRM API is reachable

check = (apiHost: string): boolean => {
  token = readSecret({ name: "crm-token" })
  r = httpRequest({
    host: apiHost,
    method: "GET",
    path: "/api/health",
    headers: { "authorization": token }
  })
  parsed = jsonParse({ text: r })
  return parsed.ok == true
}`,

  signature: `// computed signature for sync.ss
{
  name: "sync",
  params: [
    { name: "apiHost", type: "string" },
    { name: "dbHost", type: "string" }
  ],
  secretsRead: ["crm-token"],
  secretsWritten: [],
  hosts: ["apiHost", "dbHost"],
  envReads: [],
  dataFlow: {
    "host:apiHost": ["secret:crm-token"],
    "host:dbHost": ["host:apiHost"],
    "return": ["host:dbHost"]
  }
}`,
};

const CodeBlock = ({
  title,
  children,
}: {
  title: string;
  children: string;
}) => (
  <div className="overflow-hidden border border-border">
    <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-4 py-2">
      <span className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
        {title}
      </span>
    </div>
    <pre className="overflow-x-auto p-4 text-xs leading-relaxed">
      <code>{children}</code>
    </pre>
  </div>
);

const SkillsPage = () => (
  <div className="flex min-h-full flex-col">
    <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6 sm:px-8 lg:px-12">
        <a href="/" className="font-mono text-sm font-bold tracking-tight">
          safe<span className="text-emerald-500">script</span>
        </a>
        <nav className="flex items-center gap-1">
          <a
            href="/#docs"
            className="rounded-none px-3 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Docs
          </a>
          <a
            href="/skills"
            className="rounded-none px-3 py-1.5 font-mono text-xs text-foreground transition-colors"
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
      <div className="mx-auto max-w-3xl px-6 py-16 sm:px-8 sm:py-24 lg:px-12">
        <h1 className="mb-4 font-mono text-2xl font-bold tracking-tight sm:text-3xl">
          Skills need scripts
        </h1>
        <p className="mb-12 text-lg leading-relaxed text-muted-foreground">
          And scripts need safety guarantees.
        </p>

        {/* The problem */}
        <section className="prose-safescript mb-16">
          <h2 className="font-mono text-lg font-bold tracking-tight mt-0 mb-6 pb-3 border-b border-border">
            The problem
          </h2>
          <p>
            AI agent skills are mostly markdown files. Instructions, context, a
            few examples. They work surprisingly well for telling an agent{" "}
            <em>what</em> to do. But they have no way to include code that
            actually <em>does</em> things.
          </p>
          <p>
            Some skills need to call APIs, transform data, read credentials. The
            agent can write that code on the fly, but then you&apos;re trusting
            generated code with your secrets. Or the skill author embeds a bash
            script, and now you&apos;re trusting them not to{" "}
            <code>curl</code> your environment variables to a remote server.
          </p>
          <p>
            There&apos;s no middle ground. Either skills are pure text and
            can&apos;t do anything, or they include executable code and you
            can&apos;t trust them.
          </p>
        </section>

        {/* What safescript adds */}
        <section className="prose-safescript mb-16">
          <h2 className="font-mono text-lg font-bold tracking-tight mt-0 mb-6 pb-3 border-b border-border">
            What safescript adds
          </h2>
          <p>
            A skill should be able to bundle scripts that are safe by
            construction. Not sandboxed. Not permission-prompted. Actually
            provably safe. That means:
          </p>
          <ul>
            <li>
              Every secret read, every host contacted, every data flow is
              declared in a static signature you can inspect before anything runs.
            </li>
            <li>
              Every program terminates. No infinite loops, no runaway recursion.
              The language can&apos;t express a program that hangs.
            </li>
            <li>
              Hash pinning on dependencies. If the code changes semantically, the
              hash changes, the build breaks. No silent updates.
            </li>
          </ul>
          <p>
            A skill bundles <code>.ss</code> files alongside its markdown. The
            host knows exactly what those scripts can do before executing them.
            The agent calls them as tools, passing arguments, getting results
            back.
          </p>
        </section>

        {/* Example skill */}
        <section className="mb-16">
          <h2 className="font-mono text-lg font-bold tracking-tight mt-0 mb-6 pb-3 border-b border-border">
            Example: a CRM sync skill
          </h2>
          <p className="mb-8 leading-relaxed text-foreground/85 text-[0.9375rem]">
            An imaginary skill that pulls contacts from a CRM API and syncs
            them to a database. Three safescript files.
          </p>

          <div className="space-y-6">
            <CodeBlock title="sync.ss">{code.sync}</CodeBlock>
            <CodeBlock title="format.ss">{code.format}</CodeBlock>
            <CodeBlock title="check.ss">{code.check}</CodeBlock>
          </div>
        </section>

        {/* What you get */}
        <section className="prose-safescript mb-16">
          <h2 className="font-mono text-lg font-bold tracking-tight mt-0 mb-6 pb-3 border-b border-border">
            What the host sees
          </h2>
          <p>
            Before running anything, the host computes the signature of{" "}
            <code>sync.ss</code>. It gets back a complete description of what
            the script does:
          </p>

          <div className="my-8">
            <CodeBlock title="signature">{code.signature}</CodeBlock>
          </div>

          <p>
            The host can now make a decision. Does this skill need to read{" "}
            <code>crm-token</code>? Yes, that&apos;s the whole point. Does it
            contact the two hosts the caller passes in? Yes. Does it send the
            CRM token to the CRM host? Yes. Does data from the CRM flow to the
            database? Yes.
          </p>
          <p>
            All of that is knowable before execution. If a skill update adds a
            new secret read or a new host, the signature changes. The host
            catches it automatically.
          </p>
        </section>

        {/* Compare */}
        <section className="prose-safescript mb-16">
          <h2 className="font-mono text-lg font-bold tracking-tight mt-0 mb-6 pb-3 border-b border-border">
            Compare this to the alternatives
          </h2>
          <p>
            A bash script in a skill? You&apos;d have to read every line, hope
            there&apos;s no obfuscated <code>eval</code>, and pray the author
            doesn&apos;t push a malicious update.
          </p>
          <p>
            A Python or TypeScript snippet? Same story but with more surface
            area. Dynamic imports, eval, subprocess, network access, all
            available by default.
          </p>
          <p>
            A sandboxed runtime? Better, but now you need container
            infrastructure, and you still don&apos;t know what the code{" "}
            <em>does</em> until you run it.
          </p>
          <p>
            Safescript scripts are the only option where the safety properties
            come from the code itself, not from wrapping it in something else.
          </p>
        </section>
      </div>
    </main>

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

export { SkillsPage as default };
