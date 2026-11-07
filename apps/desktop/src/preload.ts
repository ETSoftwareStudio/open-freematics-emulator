import { contextBridge, ipcRenderer } from "electron";
import { APPEARANCE_CHANNELS, type Appearance } from "./appearance.ts";
import { SERVER_URL_ARG } from "./origin.ts";

const serverUrl = process.argv
  .find((argument) => argument.startsWith(SERVER_URL_ARG))
  ?.slice(SERVER_URL_ARG.length);

// The page gets the server URL and three calls, nothing else: no Node, no generic IPC.
contextBridge.exposeInMainWorld("fme", {
  serverUrl,
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
