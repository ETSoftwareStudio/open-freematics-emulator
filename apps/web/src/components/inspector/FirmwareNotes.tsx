import type { UnsentEdit } from "@fme/contracts";
import { LockIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { type firmwareLock, unsentNote } from "./model";

/** Why a setting is locked, with the detail in its tooltip. */
export function FirmwareLockNote({
  lock,
  className,
}: {
  lock: NonNullable<ReturnType<typeof firmwareLock>>;
  className?: string;
}) {
  return (
    <p
      className={cn("flex items-center gap-1.25 text-subtle-foreground", className)}
      title={lock.title}
    >
      <LockIcon className="size-3 shrink-0" />
      {lock.label}
    </p>
  );
}

/** An edit staged while disconnected that connect couldn't send. */
export function UnsentNote({ edit }: { edit: UnsentEdit }) {
  return (
    <p className="flex gap-1.25 text-warning-foreground">
      <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
      {unsentNote(edit)}
    </p>
  );
}
