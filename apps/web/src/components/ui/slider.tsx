"use client";

import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import type * as React from "react";

import { cn } from "~/lib/utils";

function Slider({
  className,
  ...props
}: SliderPrimitive.Root.Props<number> & { className?: string }): React.ReactElement {
  return (
    <SliderPrimitive.Root
      className={cn("data-[orientation=horizontal]:w-full", className)}
      data-slot="slider"
      {...props}
    >
      <SliderPrimitive.Control className="flex h-5 w-full touch-none select-none items-center data-disabled:opacity-64">
        <SliderPrimitive.Track className="relative h-1 w-full grow rounded-full bg-input">
          <SliderPrimitive.Indicator className="rounded-full bg-primary" />
          <SliderPrimitive.Thumb className="size-4 rounded-full border border-primary bg-background shadow-xs outline-none transition-[box-shadow] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background" />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
