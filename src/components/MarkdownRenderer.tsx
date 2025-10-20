import React from 'react';

interface MarkdownRendererProps {
  content: string;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content }) => {
  const renderMarkdown = (text: string) => {
    // Split by code blocks first
    const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/g);
    
    return parts.map((part, index) => {
      // Code block
      if (part.startsWith('```') && part.endsWith('```')) {
        const code = part.slice(3, -3);
        const lines = code.split('\n');
        const language = lines[0].trim();
        const codeContent = lines.slice(1).join('\n');
        
        return (
          <pre key={index} className="bg-neutral-100 dark:bg-neutral-800 rounded-lg p-4 my-2 overflow-x-auto">
            {language && (
              <div className="text-xs text-neutral-500 dark:text-neutral-400 mb-2">{language}</div>
            )}
            <code className="text-sm text-neutral-900 dark:text-neutral-100">{codeContent}</code>
          </pre>
        );
      }
      
      // Inline code
      if (part.startsWith('`') && part.endsWith('`')) {
        return (
          <code key={index} className="bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 rounded text-sm">
            {part.slice(1, -1)}
          </code>
        );
      }
      
      // Process other markdown
      return <span key={index} dangerouslySetInnerHTML={{ __html: processInlineMarkdown(part) }} />;
    });
  };

  const processInlineMarkdown = (text: string): string => {
    let processed = text;
    
    // Headers (must be before bold/italic)
    processed = processed.replace(/^### (.+)$/gm, '<h3 class="text-lg font-bold mt-4 mb-2 text-neutral-900 dark:text-white">$1</h3>');
    processed = processed.replace(/^## (.+)$/gm, '<h2 class="text-xl font-bold mt-4 mb-2 text-neutral-900 dark:text-white">$1</h2>');
    processed = processed.replace(/^# (.+)$/gm, '<h1 class="text-2xl font-bold mt-4 mb-2 text-neutral-900 dark:text-white">$1</h1>');
    
    // Bold: **text** or __text__
    processed = processed.replace(/\*\*(.+?)\*\*/g, '<strong class="font-bold text-neutral-900 dark:text-white">$1</strong>');
    processed = processed.replace(/__(.+?)__/g, '<strong class="font-bold text-neutral-900 dark:text-white">$1</strong>');
    
    // Italic: *text* or _text_ (but not in URLs or already processed)
    processed = processed.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em class="italic">$1</em>');
    processed = processed.replace(/(?<!_)_([^_]+?)_(?!_)/g, '<em class="italic">$1</em>');
    
    // Strikethrough: ~~text~~
    processed = processed.replace(/~~(.+?)~~/g, '<del class="line-through opacity-70">$1</del>');
    
    // Links: [text](url)
    processed = processed.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" class="text-blue-600 dark:text-blue-400 hover:underline font-medium" target="_blank" rel="noopener noreferrer">$1</a>');
    
    // Lists - unordered
    processed = processed.replace(/^- (.+)$/gm, '<div class="flex gap-2 my-1"><span class="text-neutral-600 dark:text-neutral-400">•</span><span>$1</span></div>');
    
    // Lists - ordered
    let orderCounter = 0;
    processed = processed.replace(/^\d+\. (.+)$/gm, () => {
      orderCounter++;
      return `<div class="flex gap-2 my-1"><span class="text-neutral-600 dark:text-neutral-400 font-medium">${orderCounter}.</span><span>$1</span></div>`;
    });
    
    // Line breaks (double newline = paragraph, single = br)
    processed = processed.replace(/\n\n/g, '</p><p class="my-2">');
    processed = processed.replace(/\n/g, '<br />');
    
    // Wrap in paragraph if not already wrapped
    if (!processed.startsWith('<')) {
      processed = '<p class="my-1">' + processed + '</p>';
    }
    
    return processed;
  };

  return (
    <div className="markdown-content">
      {renderMarkdown(content)}
    </div>
  );
};
