import { ClusterPanel } from "./components/cluster/ClusterPanel";
import { ConnectionBar } from "./components/emulator/ConnectionBar";
import { ConsolePanel } from "./components/emulator/ConsolePanel";
import { DevicePanel } from "./components/emulator/DevicePanel";
import { DtcPanel } from "./components/emulator/DtcPanel";
import { FirmwarePanel } from "./components/emulator/FirmwarePanel";
import { ErrorBanner } from "./components/emulator/ErrorBanner";
import { PidPanel } from "./components/emulator/PidPanel";
import { ReadinessPanel } from "./components/emulator/ReadinessPanel";
import { ScanToolPanel } from "./components/emulator/ScanToolPanel";

export function App() {
  return (
    <div className="min-h-svh">
      <ConnectionBar />
      <main className="mx-auto grid max-w-7xl grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2 empty:hidden">
          <ErrorBanner />
        </div>
        <ClusterPanel className="lg:col-span-2" />
        <div className="flex min-w-0 flex-col gap-4">
          <DevicePanel />
          <PidPanel />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <ScanToolPanel />
          <DtcPanel />
          <ReadinessPanel />
          <FirmwarePanel />
        </div>
        <ConsolePanel className="lg:col-span-2" />
      </main>
    </div>
  );
}
