import type { MouseEvent, AnchorHTMLAttributes } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { openUrl } from "@tauri-apps/plugin-opener";

type Props = { content: string; className?: string };

const OPENABLE = new Set(["http:", "https:", "mailto:", "tel:"]);

function externalHref(href: string): string | null {
  try {
    const url = new URL(href, window.location.href);
    if (!OPENABLE.has(url.protocol)) return null;
    if (url.origin === window.location.origin) return null;
    return url.href;
  } catch {
    return null;
  }
}

function MarkdownLink({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    const url = externalHref(event.currentTarget.href);
    if (url) void openUrl(url).catch(() => {});
  }

  return (
    <a {...props} href={href} onClick={onClick}>
      {children}
    </a>
  );
}

export function Markdown({ content, className }: Props) {
  return (
    <div className={className ?? "md"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{ a: MarkdownLink }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
