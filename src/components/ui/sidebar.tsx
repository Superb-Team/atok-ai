import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

export interface SidebarItem {
  key: string;
  label: string;
  icon: LucideIcon;
  onClick: () => void;
}

interface AppSidebarProps {
  items: SidebarItem[];
  bottomItems: SidebarItem[];
  activeKey: string;
  footer?: React.ReactNode;
}

function SidebarButton({
  item,
  active,
}: {
  item: SidebarItem;
  active: boolean;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={item.onClick}
      // WebKitGTK matches :focus-visible on mouse clicks, which left the focus
      // ring stuck on the last clicked item; suppress focus-from-mouse so the
      // ring only ever appears for keyboard navigation.
      onMouseDown={(e) => e.preventDefault()}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors duration-150",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        "active:scale-[0.985]",
        active
          ? "bg-gradient-to-r from-primary/14 to-primary/5 font-semibold text-foreground"
          : "font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute left-0 top-1/2 h-[18px] w-[3px] -translate-y-1/2 rounded-full bg-primary transition-all duration-200",
          active ? "opacity-100" : "opacity-0 scale-y-50"
        )}
      />
      <Icon
        className={cn(
          "h-[17px] w-[17px] shrink-0 transition-colors duration-150",
          active
            ? "text-primary"
            : "text-sidebar-foreground/50 group-hover:text-sidebar-foreground/80"
        )}
        strokeWidth={active ? 2 : 1.75}
      />
      {item.label}
    </button>
  );
}

export function AppSidebar({ items, bottomItems, activeKey, footer }: AppSidebarProps) {
  return (
    <nav
      aria-label="Main"
      className="flex h-full w-[224px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar"
    >
      <div className="flex items-center gap-2.5 px-4 pb-5 pt-5">
        <img
          src="/logo-atok.png"
          alt=""
          className="h-8 w-8 shrink-0 rounded-lg object-contain"
        />
        <div className="min-w-0 leading-none">
          <p className="font-display text-[15px] font-semibold tracking-tight text-sidebar-foreground">
            Atok.ai
          </p>
          <p className="mt-1 font-mono text-[10px] tracking-wide text-sidebar-foreground/45">
            workspace
          </p>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2.5">
        {items.map((item) => (
          <SidebarButton key={item.key} item={item} active={item.key === activeKey} />
        ))}
      </div>

      <div className="flex flex-col gap-0.5 px-2.5 pb-3">
        {bottomItems.map((item) => (
          <SidebarButton key={item.key} item={item} active={item.key === activeKey} />
        ))}
      </div>

      {footer && (
        <div className="border-t border-sidebar-border px-3 py-3">{footer}</div>
      )}
    </nav>
  );
}
