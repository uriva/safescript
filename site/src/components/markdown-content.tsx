"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark-dimmed.css";
import safescriptLanguage from "./safescript-language";

// Register the custom language with rehype-highlight (lowlight under the hood).
// `safescript` aliases also catch the common ` ```ts ` / ` ```typescript `
// fences are handled by highlight.js's built-ins; explicit ` ```safescript `
// or ` ```ss ` fences trigger our grammar.
const rehypeHighlightOptions = {
  languages: { safescript: safescriptLanguage },
  // Allow auto-detection to fall back when the fence doesn't match a known lang.
  detect: true,
};

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");

const MarkdownContent = ({ content }: { content: string }) => {
  const withoutTitle = content.replace(/^# safescript\n+/, "");

  return (
    <article className="prose-safescript">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, rehypeHighlightOptions]]}
        components={{
          h2: ({ children }) => {
            const text = String(children);
            const id = slugify(text);
            return (
              <h2 id={id}>
                {children}
              </h2>
            );
          },
          h3: ({ children }) => {
            const text = String(children);
            const id = slugify(text);
            return (
              <h3 id={id}>
                {children}
              </h3>
            );
          },
        }}
      >
        {withoutTitle}
      </ReactMarkdown>
    </article>
  );
};

export { MarkdownContent, slugify };
