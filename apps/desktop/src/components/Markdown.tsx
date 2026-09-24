import type { MouseEvent, AnchorHTMLAttributes } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { openUrl } from "@tauri-apps/plugin-opener";

type Props = {
  content: string;
  className?: string;
  onLinkError?: (message: string) => void;
};

const OPEN_FAILED = "Could not open the system browser.";
const OPENABLE = new Set(["http:", "https:", "mailto:", "tel:"]);
const schema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "tel"],
  },
};

function urlTransform(value: string) {
  return /^tel:/i.test(value) ? value : defaultUrlTransform(value);
}

function externalHref(href: string): string | null {
  try {
    const url = new URL(href.startsWith("//") ? `https:${href}` : href, window.location.href);
    if (!OPENABLE.has(url.protocol)) return null;
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin === window.location.origin) {
      return null;
    }
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
    const raw = href ?? event.currentTarget.getAttribute("href");
    const url = raw ? externalHref(raw) : null;
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
        rehypePlugins={[[rehypeSanitize, schema]]}
        urlTransform={urlTransform}
        components={{
          a: (props) => <MarkdownLink {...props} onLinkError={onLinkError} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
