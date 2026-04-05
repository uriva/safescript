"use client";

import { useEffect, useState, useRef } from "react";
import { slugify } from "./markdown-content";

type TocEntry = {
  readonly id: string;
  readonly text: string;
  readonly level: 2 | 3;
};

const extractHeadings = (markdown: string): readonly TocEntry[] => {
  const lines = markdown.replace(/^# safescript\n+/, "").split("\n");
  const entries: TocEntry[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const h2 = line.match(/^## (.+)/);
    if (h2) {
      entries.push({ id: slugify(h2[1]), text: h2[1], level: 2 });
      continue;
    }
    const h3 = line.match(/^### (.+)/);
    if (h3) {
      entries.push({ id: slugify(h3[1]), text: h3[1], level: 3 });
    }
  }

  return entries;
};

const DocsToc = ({ content }: { content: string }) => {
  const headings = extractHeadings(content);
  const [activeId, setActiveId] = useState("");
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    const elements = headings
      .map((h) => document.getElementById(h.id))
      .filter(Boolean) as HTMLElement[];

    if (elements.length === 0) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length > 0) {
          setActiveId(visible[0].target.id);
        }
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: 0 },
    );

    for (const el of elements) {
      observerRef.current.observe(el);
    }

    return () => observerRef.current?.disconnect();
  }, [headings]);

  return (
    <nav className="hidden lg:block">
      <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto">
        <p className="mb-3 font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
          On this page
        </p>
        <ul className="space-y-0.5 border-l border-border">
          {headings.map((h) => (
            <li key={h.id}>
              <a
                href={`#${h.id}`}
                className={[
                  "block py-1 font-mono text-xs transition-colors",
                  h.level === 2 ? "pl-3" : "pl-6",
                  activeId === h.id
                    ? "border-l-2 border-emerald-500 -ml-px text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                ].join(" ")}
              >
                {h.text}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
};

export { DocsToc };
