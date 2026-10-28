import type * as React from "react";
import { cn } from "~/lib/utils";

function Root({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      className={cn("flex flex-col rounded-xl border bg-card text-card-foreground", className)}
      {...props}
    />
  );
}

function Header({ className, ...props }: React.ComponentProps<"header">) {
  return (
    <header
      className={cn("flex min-h-12 items-center gap-3 border-b px-4 py-2.5", className)}
      {...props}
    />
  );
}

function Title({ className, ...props }: React.ComponentProps<"h2">) {
  return <h2 className={cn("font-medium text-sm", className)} {...props} />;
}

function Description({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-muted-foreground text-xs", className)} {...props} />;
}

function Actions({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("ms-auto flex items-center gap-2", className)} {...props} />;
}

function Body({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("p-4", className)} {...props} />;
}

export const Panel = { Root, Header, Title, Description, Actions, Body };
