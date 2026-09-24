import type { MouseEvent, AnchorHTMLAttributes } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { openUrl } from "@tauri-apps/plugin-opener";

type Props = {
  content: string;
  className?: string;
  onLinkError?: (message: string) => void;
};

const OPEN_FAILED = "Could not open the system browser.";
const OPENABLE = new Set(["http:", "https:", "mailto:"]);

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

function MarkdownLink({
  href,
  children,
  onLinkError,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & Pick<Props, "onLinkError">) {
  function activate(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    const url = externalHref(event.currentTarget.href);
    if (!url) return;
    void openUrl(url).catch((err) => {
      onLinkError?.((err as Error).message || OPEN_FAILED);
    });
  }

  function onAuxClick(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 1) return;
    activate(event);
  }

  return (
    <a {...props} href={href} onClick={activate} onAuxClick={onAuxClick}>
      {children}
    </a>
  );
}

export function Markdown({ content, className, onLinkError }: Props) {
  return (
    <div className={className ?? "md"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: (props) => <MarkdownLink {...props} onLinkError={onLinkError} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
