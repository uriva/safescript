"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark-dimmed.css";

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
        rehypePlugins={[rehypeHighlight]}
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
