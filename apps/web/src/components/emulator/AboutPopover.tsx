import { SquareArrowOutUpRightIcon } from "lucide-react";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";

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
      <PopoverPopup align="start" className="w-80" width="auto">
        <PopoverTitle className="font-medium text-sm">About Freematics Emulator</PopoverTitle>
        <p className="mt-2 text-xs">
          An independent, unofficial app for the Freematics OBD-II Emulator MK2. It is not
          affiliated with, endorsed by or supported by Freematics.
        </p>
        <p className="mt-2 text-muted-foreground text-xs">
          Freematics and product names are trademarks of their owner, used here only to say which
          device the app works with. For help with the device itself, contact Freematics.
        </p>
        <a
          href="https://freematics.com/products/freematics-obd-emulator-mk2/"
          target="_blank"
          rel="noreferrer noopener"
          className="mt-3 inline-flex items-center gap-1.5 font-medium text-info-foreground text-xs hover:underline"
        >
          <SquareArrowOutUpRightIcon className="size-3.5" />
          Official MK2 product page
        </a>
      </PopoverPopup>
    </Popover>
  );
}
