"use client";

import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import type * as React from "react";

import { cn } from "~/lib/utils";

const SIZES = {
  default: { control: "h-5", track: "h-1", thumb: "size-4" },
  sm: { control: "h-4", track: "h-0.5", thumb: "size-3" },
} as const;

const VARIANTS = {
  default: { indicator: "bg-primary", thumb: "border-primary bg-background" },
  /** For dense rows of values, where the signal color would mark every row as active. */
  neutral: {
    indicator: "bg-muted-foreground",
    thumb: "border-input bg-popover shadow-sm/10 dark:bg-foreground/85",
  },
} as const;

function Slider({
  className,
  size = "default",
  variant = "default",
  ...props
}: SliderPrimitive.Root.Props<number> & {
  className?: string;
  size?: keyof typeof SIZES;
  variant?: keyof typeof VARIANTS;
}): React.ReactElement {
  return (
    <SliderPrimitive.Root
      className={cn("data-[orientation=horizontal]:w-full", className)}
      data-slot="slider"
      {...props}
    >
      <SliderPrimitive.Control
        className={cn(
          "flex w-full touch-none select-none items-center data-disabled:opacity-64",
          SIZES[size].control,
        )}
      >
        <SliderPrimitive.Track
          className={cn("relative w-full grow rounded-full bg-input", SIZES[size].track)}
        >
          <SliderPrimitive.Indicator className={cn("rounded-full", VARIANTS[variant].indicator)} />
          <SliderPrimitive.Thumb
            className={cn(
              "rounded-full border shadow-xs outline-none transition-[box-shadow] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              SIZES[size].thumb,
              VARIANTS[variant].thumb,
            )}
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
