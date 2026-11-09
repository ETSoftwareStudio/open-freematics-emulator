// Gives the page `window.fme` (`lib/desktopBridge.ts`): the server URL and three appearance calls.
(() => {
  const internals = () => window.__TAURI_INTERNALS__;
  const event = "__FME_APPEARANCE_EVENT__";
  Object.defineProperty(window, "fme", {
    value: Object.freeze({
      serverUrl: __FME_SERVER_URL__,
      appearance: Object.freeze({
        get: () => internals().invoke("appearance_get"),
        set: (appearance) => internals().invoke("appearance_set", { appearance }),
        onChange: (listener) => {
          const handler = internals().transformCallback((message) => listener(message.payload));
          const id = internals().invoke("plugin:event|listen", {
            event,
            target: { kind: "Any" },
            handler,
          });
          return () => {
            void id.then((eventId) =>
              internals().invoke("plugin:event|unlisten", { event, eventId }),
            );
          };
        },
      }),
    }),
  });
})();
