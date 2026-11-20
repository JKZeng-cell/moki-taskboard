import { msg } from "./i18n.ts";
import { memo, useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { action, openFile, openWebLink } from "./bridge.ts";

function linkKind(href: string) {
  if (!href || /[\u0000-\u001f]/.test(href) || /^[\\/]{2}/.test(href) || href.startsWith("#")) return;
  if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) return "web";
  if (/^file:\/\/\//i.test(href) || /^\/?[a-z]:[\\/]/i.test(href) || !/^[a-z][\w+.-]*:/i.test(href)) return "file";
}

function inboxItem(value: string) {
  const directive = /^::inbox-item\{([^\n]*)\}$/.exec(value.trim());
  if (!directive) return;
  const fields = new Map([...directive[1].matchAll(/(?:^|\s)(title|summary)="((?:[^"\\]|\\.)*)"/g)]
    .map(([,key,field]) => [key, field.replace(/\\(["\\])/g, "$1")]));
  const title = fields.get("title");
  if (title) return { title, summary: fields.get("summary") };
}

export const SessionMarkdown = memo(function SessionMarkdown({ summary, projectId, threadId, completeExcerpt, nativeFiles }: {
  summary: string; projectId: string; threadId: string; completeExcerpt: boolean; nativeFiles: boolean;
}) {
  const [detail, setDetail] = useState<{ text: string; truncated: boolean }>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!completeExcerpt) return;
    let active = true;
    action<{ text: string; truncated: boolean }>("thread.summary", { projectId, threadId })
      .then(result => { if (active && result.text.startsWith(summary)) setDetail(result); })
      .catch(() => { if (active) setDetail({ text: summary, truncated: true }); });
    return () => { active = false; };
  }, [summary, projectId, threadId, completeExcerpt]);

  async function follow(href: string) {
    setError("");
    try {
      if (linkKind(href) === "web") { await openWebLink(href); return; }
      const file = await action<{ path: string } | { versionId: string }>("thread.summaryFile", { projectId, threadId, href });
      const target = "path" in file ? file : await action<{ path: string }>("asset.preview", { projectId, versionId: file.versionId });
      await openFile(target);
    } catch (e) { setError((e as Error).message); }
  }

  const body = detail?.text || summary;
  return <section className="session-markdown" aria-label={msg("会话摘要")}>
    <Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={(url, key) => key === "href" && linkKind(url) ? url : ""} components={{
      p({ children, node }) {
        const start = node?.position?.start.offset, end = node?.position?.end.offset;
        const item = start !== undefined && end !== undefined ? inboxItem(body.slice(start, end)) : undefined;
        return item ? <aside className="summary-inbox" role="note"><strong>{item.title}</strong>{item.summary && <p>{item.summary}</p>}</aside> : <p>{children}</p>;
      },
      table: ({ children }) => <div className="summary-table"><table>{children}</table></div>,
      img: ({ alt }) => <span>{alt}</span>,
      a({ href = "", children }) {
        const kind = linkKind(href);
        if (kind === "web") return <a href={href} target="_blank" rel="noopener noreferrer"
          onClick={event => { event.preventDefault(); void follow(href); }}>{children}</a>;
        if (kind === "file" && nativeFiles) return <button type="button" className="summary-file-link" title={href}
          onClick={() => void follow(href)}>{children}</button>;
        return <span title={kind === "file" ? href : undefined}>{children}</span>;
      }
    }}>{body}</Markdown>
    {detail?.truncated && <small className="muted">{msg("当前显示摘要片段，可打开会话查看全文。")}</small>}
    {error && <p role="alert" className="error-text">{error}</p>}
  </section>;
});
