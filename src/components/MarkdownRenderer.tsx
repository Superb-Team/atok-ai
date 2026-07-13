import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { convertFileSrc } from '@tauri-apps/api/core';
import { openPath, openUrl } from '@tauri-apps/plugin-opener';

interface MarkdownRendererProps {
  content: string;
}

// Note markdown references local assets by absolute path (Obsidian model);
// the webview can only load them through Tauri's asset protocol.
const isLocalPath = (src: string) => src.startsWith('/') || /^[A-Za-z]:[\\/]/.test(src);

const MarkdownImage: React.FC<React.ImgHTMLAttributes<HTMLImageElement>> = ({ src, alt }) => {
  if (!src) return null;
  const resolved = isLocalPath(src) ? convertFileSrc(src) : src;
  return (
    <img
      src={resolved}
      alt={alt ?? ''}
      loading="lazy"
      decoding="async"
      className="my-4 max-w-full rounded-2xl border border-black/10 shadow-md dark:border-white/10 dark:shadow-lg dark:shadow-black/20"
    />
  );
};

const MarkdownLink: React.FC<React.AnchorHTMLAttributes<HTMLAnchorElement>> = ({
  href,
  children,
}) => {
  const handleClick = (event: React.MouseEvent) => {
    if (!href) return;
    event.preventDefault();
    const action = isLocalPath(href) ? openPath(href) : openUrl(href);
    action.catch((err) => console.error('Failed to open link:', err));
  };
  return (
    <a href={href} onClick={handleClick} className="cursor-pointer">
      {children}
    </a>
  );
};

const markdownComponents = { img: MarkdownImage, a: MarkdownLink };

// Memoized: re-parsing a long note (transcript + screenshots) synchronously on
// every parent render blocks the main thread and makes the whole window laggy.
export const MarkdownRenderer = React.memo(({ content }: MarkdownRendererProps) => {
  return (
    <div className="prose prose-neutral dark:prose-invert max-w-none prose-headings:text-inherit prose-p:text-inherit prose-strong:text-inherit prose-li:text-inherit">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
