import { Moon, Sun, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme, type ResolvedTheme } from "./theme-provider";

const OPTIONS: { value: ResolvedTheme; label: string; Icon: LucideIcon }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

/**
 * Sun / moon theme switch, per the Lamplit Study mockup.
 *
 * The bar reads as two icons — sun (light) and moon (dark). Clicking one sets a
 * concrete theme; `system` stays reachable in that whichever side the OS resolves
 * to is shown as active until the user makes an explicit choice. The active icon
 * is tinted with the ember primary and carries `aria-pressed`. Dependency-free:
 * just the installed button styles and two lucide icons.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <div
      role="group"
      aria-label="Theme"
      className="flex items-center gap-0.5 rounded-md border bg-background p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = resolvedTheme === value;
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
              active && "bg-primary/15 text-primary",
            )}
          >
            <Icon className="size-4" />
          </button>
        );
      })}
    </div>
  );
}
