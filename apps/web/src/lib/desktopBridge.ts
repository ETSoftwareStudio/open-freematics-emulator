import type { Appearance } from "./appearance";

/** What the desktop app's preload exposes; absent in a plain browser. */
interface DesktopBridge {
  /** The bundled server's WebSocket: the window loads the web app from its own origin. */
  readonly serverUrl?: string;
  readonly appearance: {
    get(): Promise<Appearance>;
    set(appearance: Appearance): Promise<void>;
    onChange(listener: (appearance: Appearance) => void): () => void;
  };
}

declare global {
  interface Window {
    fme?: DesktopBridge;
  }
}

export const desktopBridge = window.fme;
