import { type CxOptions, cx } from "class-variance-authority";
import { extendTailwindMerge } from "tailwind-merge";

// Register the extra font sizes so tailwind-merge does not treat text-2xs as a color.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["2xs", "3xs"] } },
});

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}
