import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { app } from "electron";
import { isAppearance, type Appearance } from "./appearance.ts";

/**
 * Settings the main process keeps. The page's localStorage can't hold them: the bundled server
 * listens on a new port each launch, so the page's origin changes.
 */
export interface Settings {
  readonly appearance: Appearance;
}

const DEFAULTS: Settings = { appearance: "system" };

const file = () => NodePath.join(app.getPath("userData"), "settings.json");

export const readSettings = (): Settings => {
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(file(), "utf8"));
    const appearance =
      typeof parsed === "object" && parsed !== null && "appearance" in parsed
        ? parsed.appearance
        : undefined;
    return { appearance: isAppearance(appearance) ? appearance : DEFAULTS.appearance };
  } catch {
    return DEFAULTS;
  }
};

export const writeSettings = (settings: Settings) => {
  try {
    NodeFS.mkdirSync(NodePath.dirname(file()), { recursive: true });
    NodeFS.writeFileSync(file(), `${JSON.stringify(settings, null, 2)}\n`);
  } catch (error) {
    console.error("Could not save settings:", error);
  }
};
