import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { Separator } from "~/components/ui/separator";
import { version } from "../../../../desktop-tauri/package.json";

export function AboutPopover() {
  return (
    <Popover>
      <PopoverTrigger
        title="About Open Freematics Emulator"
        aria-label="About Open Freematics Emulator"
        className="flex size-7 shrink-0 cursor-default items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent"
      >
        <img src="/favicon.svg" alt="" className="size-5" />
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-72" width="auto">
        <div className="flex flex-col items-center pt-1 text-center">
          <img src="/favicon.svg" alt="" className="size-16" />
          <PopoverTitle className="mt-3 font-semibold text-[0.9375rem] leading-tight">
            Open Freematics Emulator
          </PopoverTitle>
          <p className="mt-1 text-muted-foreground text-xs tabular-nums">Version {version}</p>
          <p className="mt-3 text-pretty text-xs">
            Sets what an OBD-II Emulator MK2 reports to a scan tool: live data, trouble codes and
            VIN.
          </p>
        </div>
        <Separator className="my-3" />
        <p className="text-balance text-center text-2xs text-muted-foreground">
          Unofficial. Not affiliated with, endorsed by or supported by Freematics. Freematics and
          product names are trademarks of their owner.
        </p>
        <p className="mt-2 text-center text-2xs text-muted-foreground">
          Developed by{" "}
          <a
            href="https://etsoftware.studio"
            target="_blank"
            rel="noreferrer noopener"
            className="underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground hover:decoration-current"
          >
            ET Software Studio Inc.
          </a>
        </p>
      </PopoverPopup>
    </Popover>
  );
}
