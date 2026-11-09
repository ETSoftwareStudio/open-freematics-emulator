// Makes the web toolbar's `drag-region` drag the window, as `app-region: drag` does in Chromium;
// WebKit ignores that CSS. Double-click zooms on mouseup, as the system title bar does.
(() => {
  const NO_DRAG =
    'button, a, input, select, textarea, [role="button"], [role="tab"], [data-no-drag]';
  const invoke = (command) => window.__TAURI_INTERNALS__.invoke(`plugin:window|${command}`);
  const draggable = (event) =>
    event.button === 0 &&
    event.target instanceof Element &&
    event.target.closest(".drag-region") !== null &&
    event.target.closest(NO_DRAG) === null;
  let pressed = null;
  document.addEventListener("mousedown", (event) => {
    if (!draggable(event)) return;
    if (event.detail === 2) {
      pressed = { x: event.clientX, y: event.clientY };
    } else if (event.detail === 1) {
      event.preventDefault();
      void invoke("start_dragging");
    }
  });
  document.addEventListener("mouseup", (event) => {
    if (
      event.detail === 2 &&
      pressed?.x === event.clientX &&
      pressed?.y === event.clientY &&
      draggable(event)
    ) {
      void invoke("internal_toggle_maximize");
    }
  });
})();
