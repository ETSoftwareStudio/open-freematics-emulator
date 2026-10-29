import { contextBridge, ipcRenderer } from "electron";
import { APPEARANCE_CHANNELS, type Appearance } from "./appearance.ts";

// The page gets these three calls and nothing else: no Node, no generic IPC.
contextBridge.exposeInMainWorld("fme", {
  appearance: {
    get: (): Promise<Appearance> => ipcRenderer.invoke(APPEARANCE_CHANNELS.get),
    set: (appearance: Appearance): Promise<void> =>
      ipcRenderer.invoke(APPEARANCE_CHANNELS.set, appearance),
    onChange: (listener: (appearance: Appearance) => void) => {
      const forward = (_event: unknown, appearance: Appearance) => listener(appearance);
      ipcRenderer.on(APPEARANCE_CHANNELS.changed, forward);
      return () => void ipcRenderer.off(APPEARANCE_CHANNELS.changed, forward);
    },
  },
});
