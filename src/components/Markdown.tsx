import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Props = { content: string; className?: string };

export function Markdown({ content, className }: Props) {
  return (
    <div className={className ?? "md"}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
