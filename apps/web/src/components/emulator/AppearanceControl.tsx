import { MonitorIcon, MoonIcon, SunIcon, SunMoonIcon } from "lucide-react";
import { SegmentedControl } from "~/components/shell/SegmentedControl";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { setAppearance, useAppearance } from "~/lib/appearance";

const ITEMS = [
  { value: "system", label: "System", icon: <MonitorIcon /> },
  { value: "light", label: "Light", icon: <SunIcon /> },
  { value: "dark", label: "Dark", icon: <MoonIcon /> },
] as const;

/** A toolbar button opening the System / Light / Dark switch, kept in sync with the View menu. */
export function AppearanceControl() {
  const appearance = useAppearance();
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="ghost-muted" size="icon-sm" aria-label="Appearance" title="Appearance">
            <SunMoonIcon />
          </Button>
        }
      />
      <PopoverPopup align="end" width="auto">
        <PopoverTitle className="mb-2 font-medium text-xs">Appearance</PopoverTitle>
        <SegmentedControl
          items={ITEMS}
          value={appearance}
          onValueChange={setAppearance}
          aria-label="Appearance"
        />
      </PopoverPopup>
    </Popover>
  );
}
