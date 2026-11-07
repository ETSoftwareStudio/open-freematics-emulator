/**
 * The window loads the web app from this fixed origin rather than the bundled server's, which takes
 * a new port each launch; localStorage is per origin, so a moving origin would forget it.
 */
export const APP_SCHEME = "fme";
export const APP_ORIGIN = `${APP_SCHEME}://app`;

/** The renderer argument that carries the bundled server's WebSocket URL to the preload. */
export const SERVER_URL_ARG = "--fme-server-url=";
