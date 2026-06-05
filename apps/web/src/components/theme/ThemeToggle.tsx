import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme, type Theme } from "./theme-provider";

const OPTIONS: { value: Theme; label: string; Icon: LucideIcon }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "system", label: "System", Icon: Monitor },
  { value: "dark", label: "Dark", Icon: Moon },
];

/**
 * Compact segmented control to switch between light / system / dark themes.
 * Uses no extra dependencies — just the installed button styles and lucide
 * icons — and reflects the active choice via aria-pressed + a highlighted pill.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <div
      role="group"
      aria-label="Theme"
      className="flex items-center gap-0.5 rounded-md border bg-background p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            title={`${label} theme`}
            aria-label={`${label} theme`}
            aria-pressed={active}
            onClick={() => setTheme(value)}
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-sm text-muted-foreground transition-colors",
              "hover:text-foreground focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-[3px]",
              active && "bg-secondary text-foreground shadow-sm",
            )}
          >
            <Icon className="size-4" />
          </button>
        );
      })}
    </div>
  );
}
