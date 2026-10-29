import { Dialog } from "@base-ui/react/dialog";
import type * as React from "react";
import { cn } from "~/lib/utils";

/** A small centred dialog at desktop density, for the preset sheets. */
export function PresetDialog({
  open,
  onOpenChange,
  title,
  description,
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[140] bg-black/20 transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0 dark:bg-black/40" />
        <Dialog.Popup
          className={cn(
            "-translate-x-1/2 fixed top-[22%] left-1/2 z-[141] flex max-h-[70dvh] w-80 flex-col rounded-xl border border-border bg-popover p-4 text-popover-foreground text-xs shadow-[0_20px_50px_-12px_rgb(0_0_0/45%)] outline-none transition-[scale,opacity] duration-150 data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0",
            className,
          )}
        >
          <Dialog.Title className="font-semibold text-[13px] text-foreground">{title}</Dialog.Title>
          {description !== undefined ? (
            <Dialog.Description className="mt-1 text-muted-foreground">
              {description}
            </Dialog.Description>
          ) : null}
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function PresetDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("mt-4 flex justify-end gap-2", className)} {...props} />;
}
