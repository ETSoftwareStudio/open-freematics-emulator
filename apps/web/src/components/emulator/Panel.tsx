import { createContext, use } from "react";
import type * as React from "react";
import { cn } from "~/lib/utils";

/** Set inside a container that already frames the panel and names it, like an inspector group. */
const Embedded = createContext(false);

function Root({ className, ...props }: React.ComponentProps<"section">) {
  const embedded = use(Embedded);
  return (
    <section
      className={cn(
        "@container flex flex-col",
        !embedded && "rounded-xl border bg-card text-card-foreground",
        className,
      )}
      {...props}
    />
  );
}

function Header({ className, ...props }: React.ComponentProps<"header">) {
  const embedded = use(Embedded);
  return (
    <header
      className={cn(
        "flex items-center gap-3",
        embedded ? "min-h-7 empty:hidden" : "min-h-12 border-b px-4 py-2.5",
        className,
      )}
      {...props}
    />
  );
}

function Title({ className, ...props }: React.ComponentProps<"h2">) {
  const embedded = use(Embedded);
  return <h2 className={cn("font-medium text-sm", embedded && "sr-only", className)} {...props} />;
}

function Description({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-muted-foreground text-xs", className)} {...props} />;
}

function Actions({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("ms-auto flex items-center gap-2", className)} {...props} />;
}

function Body({ className, ...props }: React.ComponentProps<"div">) {
  const embedded = use(Embedded);
  return <div className={cn(embedded ? "py-1" : "p-4", className)} {...props} />;
}

export const Panel = { Root, Header, Title, Description, Actions, Body, Embedded };
