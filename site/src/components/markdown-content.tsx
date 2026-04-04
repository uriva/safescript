"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark-dimmed.css";

const MarkdownContent = ({ content }: { content: string }) => {
  // Strip the first H1 (already shown in hero)
  const withoutTitle = content.replace(/^# safescript\n+/, "");

  return (
    <article className="prose-safescript">
      <ReactMarkdown 
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
      >
        {withoutTitle}
      </ReactMarkdown>
    </article>
  );
};

export { MarkdownContent };
