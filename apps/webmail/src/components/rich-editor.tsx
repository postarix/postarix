import { Button } from '@postarix/ui/components/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@postarix/ui/components/tooltip';
import { cn } from '@postarix/ui/lib/utils';
import { Bold, Italic, Link, List, ListOrdered, Quote, RemoveFormatting, Underline } from 'lucide-react';
import { type ReactNode, forwardRef, useImperativeHandle, useRef } from 'react';
import { cleanHtml } from '@/lib/rich-text';

export interface RichEditorHandle {
  /** The body as clean HTML. */
  html: () => string;
}

const ACTIONS: { label: string; shortcut?: string; icon: ReactNode; run: () => void }[] = [
  { label: 'Bold', shortcut: 'Ctrl+B', icon: <Bold aria-hidden />, run: () => document.execCommand('bold') },
  { label: 'Italic', shortcut: 'Ctrl+I', icon: <Italic aria-hidden />, run: () => document.execCommand('italic') },
  { label: 'Underline', shortcut: 'Ctrl+U', icon: <Underline aria-hidden />, run: () => document.execCommand('underline') },
  { label: 'Bulleted list', icon: <List aria-hidden />, run: () => document.execCommand('insertUnorderedList') },
  { label: 'Numbered list', icon: <ListOrdered aria-hidden />, run: () => document.execCommand('insertOrderedList') },
  { label: 'Quote', icon: <Quote aria-hidden />, run: () => document.execCommand('formatBlock', false, 'blockquote') },
  {
    label: 'Link',
    icon: <Link aria-hidden />,
    run: () => {
      const url = window.prompt('Link address (https://…)');
      if (url && /^(https?:\/\/|mailto:)/i.test(url.trim())) document.execCommand('createLink', false, url.trim());
    },
  },
  { label: 'Clear formatting', icon: <RemoveFormatting aria-hidden />, run: () => document.execCommand('removeFormat') },
];

/** The message body with simple formatting (bold, lists, links, quotes). */
export const RichEditor = forwardRef<RichEditorHandle, { initialHtml: string; autoFocus?: boolean; className?: string }>(function RichEditor(
  { initialHtml, autoFocus, className },
  ref,
) {
  const editor = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => ({ html: () => cleanHtml(editor.current?.innerHTML ?? '') }), []);

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5 border-b px-4 py-1">
        {ACTIONS.map((action) => (
          <Tooltip key={action.label}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={action.label}
                // Keep the selection in the editor.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  editor.current?.focus();
                  action.run();
                }}
              >
                {action.icon}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{action.shortcut ? `${action.label} (${action.shortcut})` : action.label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      <div
        ref={(node) => {
          editor.current = node;
          if (node && !node.dataset.ready) {
            node.innerHTML = cleanHtml(initialHtml);
            node.dataset.ready = '1';
            if (autoFocus) node.focus();
          }
        }}
        role="textbox"
        aria-multiline="true"
        aria-label="Message"
        contentEditable
        suppressContentEditableWarning
        data-placeholder="Write your message…"
        onPaste={(e) => {
          // Pasted content keeps simple formatting only.
          const html = e.clipboardData.getData('text/html');
          if (!html) return;
          e.preventDefault();
          document.execCommand('insertHTML', false, cleanHtml(html));
        }}
        className={cn(
          'min-h-72 flex-1 overflow-y-auto px-5 py-4 text-[0.95rem] leading-relaxed outline-none',
          'empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]',
          '[&_a]:text-ink [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:min-h-[1.5em] [&_ul]:list-disc [&_ul]:pl-6',
        )}
      />
    </div>
  );
});
