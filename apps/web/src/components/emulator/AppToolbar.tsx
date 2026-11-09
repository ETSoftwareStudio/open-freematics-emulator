import { PanelBottomIcon, PanelLeftIcon, PanelRightIcon } from "lucide-react";
import { SegmentedControl } from "~/components/shell/SegmentedControl";
import { Toolbar, ToolbarSection, ToolbarSeparator } from "~/components/shell/Toolbar";
import { Toggle } from "~/components/ui/toggle";
import { useWindowChrome } from "~/lib/windowChrome";
import { AboutPopover } from "./AboutPopover";
import { AppearanceControl } from "./AppearanceControl";
import { ConnectButton, ConnectionStatus, DevicePicker } from "./ConnectionControls";

export type Screen = "emulator" | "scan-tool";

export function AppToolbar({
  screen,
  onScreenChange,
  consoleOpen,
  onConsoleOpenChange,
  sideOpen,
  onSideOpenChange,
}: {
  screen: Screen;
  onScreenChange: (screen: Screen) => void;
  consoleOpen: boolean;
  onConsoleOpenChange: (open: boolean) => void;
  /** The emulator's inspector, or the scan tool's adapter sidebar. */
  sideOpen: boolean;
  onSideOpenChange: (open: boolean) => void;
}) {
  const chrome = useWindowChrome();
  const mod = chrome.modifierLabel;
  const sideLabel = screen === "emulator" ? "inspector" : "sidebar";
  return (
    <Toolbar>
      <ToolbarSection align="start">
        {chrome.desktop ? null : <AboutPopover />}
        <DevicePicker />
        <ConnectionStatus className="truncate text-muted-foreground max-desktop:hidden" />
      </ToolbarSection>
      <ToolbarSection align="center">
        <SegmentedControl
          size="toolbar"
          aria-label="Screen"
          value={screen}
          onValueChange={onScreenChange}
          items={[
            {
              value: "emulator",
              label: "Emulator",
              shortcut: `${mod}1`,
              title: `Emulator (${mod}1)`,
            },
            {
              value: "scan-tool",
              label: "Scan tool",
              shortcut: `${mod}2`,
              title: `Scan tool (${mod}2)`,
            },
          ]}
        />
      </ToolbarSection>
      <ToolbarSection align="end" className="gap-1">
        <ConnectButton />
        <ToolbarSeparator />
        <Toggle
          variant="ghost"
          size="sm"
          pressed={consoleOpen}
          onPressedChange={onConsoleOpenChange}
          aria-label={screen === "emulator" ? "Show console" : "Show traffic"}
          title={`${screen === "emulator" ? "Console" : "Traffic"} (${mod}J)`}
        >
          <PanelBottomIcon />
        </Toggle>
        <Toggle
          variant="ghost"
          size="sm"
          pressed={sideOpen}
          onPressedChange={onSideOpenChange}
          aria-label={`Show ${sideLabel}`}
          title={`${sideLabel === "inspector" ? "Inspector" : "Sidebar"} (${chrome.platform === "mac" ? "⌥⌘" : "Ctrl+Alt+"}0)`}
        >
          {screen === "emulator" ? <PanelRightIcon /> : <PanelLeftIcon />}
        </Toggle>
        <AppearanceControl />
      </ToolbarSection>
    </Toolbar>
  );
}
