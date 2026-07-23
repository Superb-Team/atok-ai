import { useEffect, useRef } from "react";
import {
  Code2,
  Heading2,
  Heading3,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  StickyNote,
  Table2,
  X,
} from "lucide-react";
import type { MarkdownBlockCommand } from "@/lib/markdown-editing";
import type { EditorBlockCommand } from "./editor-block-commands";

interface EditorCommandMenuProps {
  commands: EditorBlockCommand[];
  activeIndex: number;
  onSelect: (command: MarkdownBlockCommand) => void;
  onActiveIndexChange: (index: number) => void;
  onClose: () => void;
}

const commandIcons: Record<MarkdownBlockCommand, typeof Heading2> = {
  heading2: Heading2,
  heading3: Heading3,
  bullet: List,
  ordered: ListOrdered,
  checklist: ListChecks,
  quote: Quote,
  callout: StickyNote,
  codeBlock: Code2,
  table: Table2,
  divider: Minus,
};

export function EditorCommandMenu({
  commands,
  activeIndex,
  onSelect,
  onActiveIndexChange,
  onClose,
}: EditorCommandMenuProps) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      id="editor-command-menu"
      className="absolute left-0 top-full z-30 mt-2 w-[min(24rem,calc(100vw-5rem))] overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
      role="listbox"
      aria-label="Insert block"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div>
          <p className="text-xs font-semibold text-foreground">Insert block</p>
          <p className="text-[11px] text-muted-foreground">Type “/” on a new line anytime.</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Close insert menu"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="max-h-72 overflow-y-auto p-2">
        {commands.map(({ id, label, description }, index) => {
          const Icon = commandIcons[id];
          const active = index === activeIndex;
          return (
          <button
            key={id}
            id={`editor-command-${id}`}
            ref={(element) => {
              itemRefs.current[index] = element;
            }}
            type="button"
            role="option"
            aria-selected={active}
            tabIndex={-1}
            onMouseEnter={() => onActiveIndexChange(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(id)}
            className={`flex w-full items-start gap-2.5 rounded-lg p-2.5 text-left transition ${
              active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
            }`}
          >
            <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background">
              <Icon className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-medium text-foreground">{label}</span>
              <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
                {description}
              </span>
            </span>
          </button>
          );
        })}
        {commands.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No matching block.
          </p>
        )}
      </div>
    </div>
  );
}
