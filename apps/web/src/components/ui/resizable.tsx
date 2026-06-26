import { useEffect, useRef } from "react"
import { GripVerticalIcon } from "lucide-react"
import * as ResizablePrimitive from "react-resizable-panels"

import { cn } from "@/lib/utils"

function ResizablePanelGroup({
  className,
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean
}) {
  // The separator is a focusable splitter (tabIndex 0) whose built-in keydown
  // handler resizes the panels on arrow keys while focused. This app uses arrow
  // keys for move navigation, so a handle that keeps focus after a click/drag
  // hijacks them ("the screen moves right"). Drag-resize is pointer-driven and
  // needs no focus, so we keep the handle non-focusable by blurring it the moment
  // it gains focus — arrow keys then always reach the board. (Keyboard-resize is
  // intentionally dropped; the library exposes no prop to disable just that.)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const blur = () => el.blur()
    el.addEventListener("focus", blur)
    return () => el.removeEventListener("focus", blur)
  }, [])

  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      elementRef={ref}
      className={cn(
        "relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-4 w-3 items-center justify-center rounded-xs border bg-border">
          <GripVerticalIcon className="size-2.5" />
        </div>
      )}
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
// Imperative panel control + layout persistence, re-exported so feature code
// imports everything resizable from this one module.
export { usePanelRef, useDefaultLayout } from "react-resizable-panels"
export type { PanelImperativeHandle } from "react-resizable-panels"
