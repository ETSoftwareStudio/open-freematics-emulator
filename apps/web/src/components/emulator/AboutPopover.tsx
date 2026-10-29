import { SquareArrowOutUpRightIcon } from "lucide-react";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { Separator } from "~/components/ui/separator";
import { version } from "../../../package.json";

export function AboutPopover() {
  return (
    <Popover>
      <h1>
        <PopoverTrigger
          title="About this app"
          className="-m-1 flex items-center gap-2.5 rounded-md p-1 text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <img src="/favicon.svg" alt="" className="size-7" />
          <span className="flex flex-col leading-tight">
            <span className="font-semibold text-sm">Freematics Emulator</span>
            <span className="font-normal text-muted-foreground text-xs">
              Unofficial MK2 control app
            </span>
          </span>
        </PopoverTrigger>
      </h1>
      <PopoverPopup align="start" className="w-72" width="auto">
        <div className="flex flex-col items-center pt-1 text-center">
          <img src="/favicon.svg" alt="" className="size-16" />
          <PopoverTitle className="mt-3 font-semibold text-[0.9375rem] leading-tight">
            Freematics Emulator
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
        <a
          href="https://freematics.com/products/freematics-obd-emulator-mk2/"
          target="_blank"
          rel="noreferrer noopener"
          className="mx-auto mt-2 flex w-fit items-center gap-1 text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          MK2 product page
          <SquareArrowOutUpRightIcon className="size-3" />
        </a>
      </PopoverPopup>
    </Popover>
  );
}
