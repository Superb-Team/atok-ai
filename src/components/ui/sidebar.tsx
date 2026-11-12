import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";

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
  collapsed,
}: {
  item: SidebarItem;
  active: boolean;
  collapsed: boolean;
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
      title={collapsed ? item.label : undefined}
      className={cn(
        "group relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors duration-150",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        "active:scale-[0.985]",
        collapsed && "justify-center gap-0 px-0",
        active
          ? "bg-sidebar-foreground font-semibold text-sidebar"
          : "font-medium text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute left-0 top-1/2 h-[14px] w-px -translate-y-1/2 bg-sidebar transition-all duration-200",
          active ? "opacity-40" : "opacity-0 scale-y-50"
        )}
      />
      <Icon
        className={cn(
          "h-[17px] w-[17px] shrink-0 transition-colors duration-150",
          active
            ? "text-sidebar"
            : "text-sidebar-foreground/50 group-hover:text-sidebar-foreground/80"
        )}
        strokeWidth={active ? 2 : 1.75}
      />
      <span className={cn("min-w-0 truncate", collapsed && "sr-only")}>{item.label}</span>
    </button>
  );
}

export function AppSidebar({ items, bottomItems, activeKey, footer }: AppSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const CollapseIcon = collapsed ? ChevronRight : ChevronLeft;

  return (
    <nav
      aria-label="Main navigation"
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200 ease-out",
        collapsed ? "w-[72px]" : "w-[232px]"
      )}
    >
      <div
        className={cn(
          "flex items-center pb-5 pt-5",
          collapsed ? "justify-between gap-0 px-2" : "gap-2.5 px-4"
        )}
      >
        <img
          src="/logo-atok.png"
          alt=""
          className="h-7 w-7 shrink-0 rounded-md object-contain"
        />
        {!collapsed && (
          <div className="min-w-0 leading-none">
            <p className="font-display text-[15px] font-semibold tracking-tight text-sidebar-foreground">
              Atok.ai
            </p>
            <p className="mt-1 text-[10px] tracking-wide text-sidebar-foreground/40">
              Personal workspace
            </p>
          </div>
        )}
        <button
          type="button"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setCollapsed((current) => !current)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <CollapseIcon aria-hidden className="h-4 w-4" />
        </button>
      </div>

      <div
        className={cn(
          "flex flex-1 flex-col gap-0.5 overflow-y-auto",
          collapsed ? "px-2" : "px-2.5"
        )}
      >
        {items.map((item) => (
          <SidebarButton
            key={item.key}
            item={item}
            active={item.key === activeKey}
            collapsed={collapsed}
          />
        ))}
      </div>

      <div className={cn("flex flex-col gap-0.5 pb-3", collapsed ? "px-2" : "px-2.5")}>
        {bottomItems.map((item) => (
          <SidebarButton
            key={item.key}
            item={item}
            active={item.key === activeKey}
            collapsed={collapsed}
          />
        ))}
      </div>

      {footer && !collapsed && (
        <div className="border-t border-sidebar-border px-3 py-3">{footer}</div>
      )}
    </nav>
  );
}
