import { CodeBlock } from "@pond/ui/code-block";
import type { AssistantSource } from "@shared/assistant";
import {
  Children,
  createContext,
  isValidElement,
  type ReactNode,
  useContext,
} from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseSaveMentionHref, SaveMentionChip } from "../../composer/mention";
import { remarkSaveCitations } from "../remark-save-citations";
import { SaveCitation } from "../save-preview";
import styles from "./styles.module.css";

const whitespace = /^\s+$/;

interface ResponseRenderContext {
  streaming: boolean;
  sources: AssistantSource[];
  onOpenSave: (id: string) => void;
}

const ResponseContext = createContext<ResponseRenderContext | null>(null);

function useResponseContext() {
  const value = useContext(ResponseContext);
  if (!value) throw new Error("Response renderers require ResponseContext");
  return value;
}

function StreamingWords({
  children,
  active,
}: {
  children: ReactNode;
  active: boolean;
}) {
  if (!active) return children;
  return Children.map(children, (child) => {
    if (child == null || isValidElement(child)) return child;
    let offset = 0;
    return String(child)
      .split(/(\s+)/)
      .map((part) => {
        const start = offset;
        offset += part.length;
        return !part || whitespace.test(part) ? (
          part
        ) : (
          <span
            key={`word-${start}`}
            className={styles["streaming-word"]}
            data-streaming-word=""
          >
            {part}
          </span>
        );
      });
  });
}

function textContent(children: ReactNode): string {
  const parts = Children.toArray(children);
  const value = parts.length === 1 ? parts[0] : null;
  return value != null && !isValidElement(value) ? String(value) : "";
}

function Streamed({ children }: { children: ReactNode }) {
  const { streaming } = useResponseContext();
  return <StreamingWords active={streaming}>{children}</StreamingWords>;
}

function ResponseLink({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  const { sources, onOpenSave } = useResponseContext();
  const mentionId = parseSaveMentionHref(href ?? "");
  if (mentionId) {
    const save = sources.find((item) => item.id === mentionId);
    const title = save?.title || textContent(children) || "Untitled";
    return <SaveMentionChip id={mentionId} title={title} onOpen={onOpenSave} />;
  }
  const reference = /^#save-([1-9]\d*)$/.exec(href ?? "");
  if (reference) {
    const save = sources[Number(reference[1]) - 1];
    return save ? (
      <SaveCitation
        source={save}
        reference={Number(reference[1])}
        compact={children === String(Number(reference[1]))}
        onOpenSave={onOpenSave}
      />
    ) : (
      <span>{children}</span>
    );
  }
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

const responseComponents = {
  img: () => null,
  p: ({ node: _node, children, ...props }) => (
    <p {...props}>
      <Streamed>{children}</Streamed>
    </p>
  ),
  li: ({ node: _node, children, ...props }) => (
    <li {...props}>
      <Streamed>{children}</Streamed>
    </li>
  ),
  h1: ({ node: _node, children, ...props }) => (
    <h1 {...props}>
      <Streamed>{children}</Streamed>
    </h1>
  ),
  h2: ({ node: _node, children, ...props }) => (
    <h2 {...props}>
      <Streamed>{children}</Streamed>
    </h2>
  ),
  h3: ({ node: _node, children, ...props }) => (
    <h3 {...props}>
      <Streamed>{children}</Streamed>
    </h3>
  ),
  h4: ({ node: _node, children, ...props }) => (
    <h4 {...props}>
      <Streamed>{children}</Streamed>
    </h4>
  ),
  h5: ({ node: _node, children, ...props }) => (
    <h5 {...props}>
      <Streamed>{children}</Streamed>
    </h5>
  ),
  h6: ({ node: _node, children, ...props }) => (
    <h6 {...props}>
      <Streamed>{children}</Streamed>
    </h6>
  ),
  strong: ({ node: _node, children, ...props }) => (
    <strong {...props}>
      <Streamed>{children}</Streamed>
    </strong>
  ),
  em: ({ node: _node, children, ...props }) => (
    <em {...props}>
      <Streamed>{children}</Streamed>
    </em>
  ),
  del: ({ node: _node, children, ...props }) => (
    <del {...props}>
      <Streamed>{children}</Streamed>
    </del>
  ),
  th: ({ node: _node, children, ...props }) => (
    <th {...props}>
      <Streamed>{children}</Streamed>
    </th>
  ),
  td: ({ node: _node, children, ...props }) => (
    <td {...props}>
      <Streamed>{children}</Streamed>
    </td>
  ),
  a: ResponseLink,
  pre: ({ node, children }) => {
    const code = node?.children.find(
      (child) => child.type === "element" && child.tagName === "code",
    );
    if (code?.type !== "element") return <pre>{children}</pre>;
    const value = code.children
      .flatMap((child) => (child.type === "text" ? child.value : []))
      .join("");
    const classes = code.properties.className;
    const language = Array.isArray(classes)
      ? String(
          classes.find((name) => String(name).startsWith("language-")) ?? "",
        ).replace(/^language-/, "")
      : "";
    return <CodeBlock.Root code={value} language={language} />;
  },
  table: ({ children }) => (
    <section
      className={styles.table}
      data-scroll-fade="horizontal"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll wide tables in the side pane.
      tabIndex={0}
      aria-label="Response table"
    >
      <table>{children}</table>
    </section>
  ),
} satisfies Components;

export function safeResponseUrl(url: string): string {
  if (/^#save-[1-9]\d*$/.test(url)) return url;
  if (parseSaveMentionHref(url)) return url;
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !parsed.username &&
      !parsed.password
    )
      return parsed.href;
  } catch {}
  return "";
}

export function AssistantResponse({
  content,
  sources = [],
  streaming = false,
  onOpenSave,
}: {
  content: string;
  sources?: AssistantSource[];
  streaming?: boolean;
  onOpenSave: (id: string) => void;
}) {
  return (
    <ResponseContext.Provider value={{ streaming, sources, onOpenSave }}>
      <div className={styles.response}>
        <Markdown
          remarkPlugins={[
            remarkGfm,
            [remarkSaveCitations, { count: sources.length, source: content }],
          ]}
          skipHtml
          urlTransform={safeResponseUrl}
          components={responseComponents}
        >
          {content}
        </Markdown>
      </div>
    </ResponseContext.Provider>
  );
}
