import { useEffect, useEffectEvent, useState } from "react";
import { AppStatusBar } from "./components/emulator/AppStatusBar";
import { AppToolbar, type Screen } from "./components/emulator/AppToolbar";
import { Infobars } from "./components/emulator/Infobars";
import { EmulatorScreen } from "./components/screens/EmulatorScreen";
import { ScanToolScreen } from "./components/screens/ScanToolScreen";
import { useMediaQuery } from "./lib/useMediaQuery";
import { usePersistentState } from "./lib/usePersistentState";
import { hasModifier } from "./lib/windowChrome";

export function App() {
  const [screen, setScreen] = usePersistentState<Screen>("fme:screen", "emulator");
  const [consoleOpen, setConsoleOpen] = usePersistentState("fme:console-open", true);
  const [trafficOpen, setTrafficOpen] = usePersistentState("fme:traffic-open", true);
  const [inspectorOpen, setInspectorOpen] = usePersistentState("fme:inspector-open", true);
  const [sidebarOpen, setSidebarOpen] = usePersistentState("fme:scan-sidebar-open", true);
  // Narrow windows float the side panes over the content, closed until asked for.
  const wide = useMediaQuery("(min-width: 60rem)");
  const [overlayOpen, setOverlayOpen] = useState(false);

  const emulator = screen === "emulator";
  const drawerOpen = emulator ? consoleOpen : trafficOpen;
  const setDrawerOpen = emulator ? setConsoleOpen : setTrafficOpen;
  const sideOpen = wide ? (emulator ? inspectorOpen : sidebarOpen) : overlayOpen;
  const setSideOpen = (open: boolean) => {
    if (!wide) setOverlayOpen(open);
    else if (emulator) setInspectorOpen(open);
    else setSidebarOpen(open);
  };
  const changeScreen = (next: Screen) => {
    setScreen(next);
    setOverlayOpen(false);
  };

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (!hasModifier(event) || event.shiftKey) return;
    const action = event.altKey
      ? event.code === "Digit0"
        ? () => setSideOpen(!sideOpen)
        : null
      : event.code === "Digit1"
        ? () => changeScreen("emulator")
        : event.code === "Digit2"
          ? () => changeScreen("scan-tool")
          : event.code === "KeyJ"
            ? () => setDrawerOpen(!drawerOpen)
            : null;
    if (action === null) return;
    event.preventDefault();
    action();
  });
  // oxlint-disable-next-line fme/no-unreasoned-state-sync -- window-wide keyboard shortcuts (⌘1/⌘2 screens, ⌘J drawer, ⌥⌘0 side pane)
  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-window text-foreground">
      <h1 className="sr-only">Freematics Emulator</h1>
      <AppToolbar
        screen={screen}
        onScreenChange={changeScreen}
        consoleOpen={drawerOpen}
        onConsoleOpenChange={setDrawerOpen}
        sideOpen={sideOpen}
        onSideOpenChange={setSideOpen}
      />
      <Infobars />
      <main className="flex min-h-0 flex-1 flex-col">
        {emulator ? (
          <EmulatorScreen
            consoleOpen={consoleOpen}
            onConsoleOpenChange={setConsoleOpen}
            inspectorOpen={sideOpen}
            inspectorOverlay={!wide}
          />
        ) : (
          <ScanToolScreen
            sidebarOpen={sideOpen}
            sidebarOverlay={!wide}
            trafficOpen={trafficOpen}
            onTrafficOpenChange={setTrafficOpen}
          />
        )}
      </main>
      <AppStatusBar showAdapter={!emulator} />
    </div>
  );
}
