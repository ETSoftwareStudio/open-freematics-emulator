import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRightIcon } from "lucide-react";
import { createContext, use, useState } from "react";
import type * as React from "react";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";
import { usePersistentState } from "~/lib/usePersistentState";

const FilterContext = createContext("");

/** The inspector's filter text, lower-cased; empty when nothing is typed. */
export function useInspectorFilter() {
  return use(FilterContext);
}

/**
 * A side pane of collapsible property groups with a filter field on top. Groups whose title and
 * keywords don't match the filter hide themselves.
 */
export function Inspector({
  side = "end",
  filterPlaceholder,
  className,
  children,
  ...props
}: React.ComponentProps<"aside"> & {
  side?: "start" | "end";
  /** Shows the filter field when set. */
  filterPlaceholder?: string;
}) {
  const [filter, setFilter] = useState("");
  return (
    <aside
      className={cn(
        "flex min-h-0 flex-col border-separator bg-pane text-xs",
        side === "end" ? "border-s" : "border-e",
        className,
      )}
      {...props}
    >
      {filterPlaceholder !== undefined ? (
        <div className="shrink-0 border-b px-2.5 py-2">
          <Input
            type="search"
            size="sm"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={filterPlaceholder}
            aria-label={filterPlaceholder}
          />
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <FilterContext value={filter.trim().toLowerCase()}>{children}</FilterContext>
      </div>
    </aside>
  );
}

/** A disclosure in the inspector. Its open state is remembered per `id`. */
export function InspectorGroup({
  id,
  title,
  summary,
  keywords = "",
  defaultOpen = true,
  className,
  children,
}: {
  id: string;
  title: string;
  /** A short status at the trailing edge of the header, e.g. `2 codes`. */
  summary?: React.ReactNode;
  /** Extra words the filter matches, e.g. the PID names inside the group. */
  keywords?: string;
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = usePersistentState(`fme:inspector:${id}`, defaultOpen);
  const filter = useInspectorFilter();
  const matches = filter === "" || `${title} ${keywords}`.toLowerCase().includes(filter);
  if (!matches) return null;

  return (
    <Collapsible.Root
      open={open || filter !== ""}
      onOpenChange={setOpen}
      render={<section aria-label={title} />}
      className={cn("border-b last:border-b-0", className)}
    >
      <Collapsible.Trigger className="group flex h-7 w-full cursor-default select-none items-center gap-1.25 ps-1.5 pe-2.5 text-start font-semibold text-foreground text-xs outline-none focus-visible:bg-accent">
        <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
        {title}
        {summary !== undefined ? (
          <span className="ms-auto flex items-center gap-1.25 font-normal text-2xs text-muted-foreground">
            {summary}
          </span>
        ) : null}
      </Collapsible.Trigger>
      <Collapsible.Panel className="pe-2.5 ps-5.5 pb-2">{children}</Collapsible.Panel>
    </Collapsible.Root>
  );
}
