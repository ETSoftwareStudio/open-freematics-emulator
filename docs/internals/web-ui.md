# Web UI

## Primitives

Controls come from [`components/ui`](../../apps/web/src/components/ui): Base UI primitives with
their own look. Pick a `variant` or `size`; don't restyle one with `className`. Layout classes
(width, flex, margin, position) belong on the parent. If no variant fits and the look is generic,
add a variant to the primitive; a look that belongs to one feature stays in that feature.

Don't style a raw `<button>`, `<input>`, or `<select>` to look like a control a primitive provides.
Raw elements are right when the element isn't that control.

## Styles

Tailwind classes in the component that renders the element. Global CSS in `index.css` is only for
theme tokens and what classes can't express. Theme-only rules use `@variant dark` and
`@variant light`.

## Composition

Screens are built from the window primitives in
[`components/shell`](../../apps/web/src/components/shell) (see Window shell below). Each primitive
owns its classes and spreads the rest of its props, so features compose them instead of copying
markup.

## State

Server state comes from atoms in [`rpc/atoms.ts`](../../apps/web/src/rpc/atoms.ts): the emulator
state and traffic are streams the server pushes; commands are RPC mutations run through
`useCommand`, which reports failures to the error banner. Components never hold a copy of server
state. Local state is only for drafts the user is editing (a slider being dragged, a VIN being
typed), cleared once the command settles.

## React Compiler

`react({ compiler: true })` memoizes components, so `useMemo` and `useCallback` aren't needed.
React effects are for synchronizing with something outside React; derive in render and act in
handlers. An effect that stays states why with
`// oxlint-disable-next-line fme/no-unreasoned-state-sync -- <why>`.

## Instrument cluster

[`components/cluster`](../../apps/web/src/components/cluster) draws the dashboard: SVG gauges that
are also controls (drag the needle, arrow keys with Shift for ten steps, PageUp/PageDown,
Home/End, click the number to type) and warning lights. The sub-gauges inside the dials and the
readouts under them share that behaviour through `useGaugeControl`. Typing happens in place: `GaugeNumber`
gives the button and the input one class string so nothing moves, its steppers and Up/Down send
at once like a drag, typed text only previews as a dotted ghost until Enter, and Escape restores
the value from before editing (`valueEditing.ts` holds the tested rules).
Dial geometry lives in `gaugeGeometry.ts` and is unit-tested; a gauge's display range and zones are
UI choices and may be narrower than what the PID can encode, so the PID list stays the place for
exact values. The pointer stays inside the display range; keys and steppers move inside the PID's
limits, so a value outside the dial steps from where it is.
PID controls share `usePidControl` for drafts and send de-duplication.

The cluster follows the window, except the two round dials, which stay dark in both themes: in a
light window each sits on a dark face with a light bezel ring (`--dial-face`, `--dial-shadow`).
Its colors are the `gauge-*` tokens in `index.css`, with a light and a dark set: `gauge-dark`
scopes the dark set onto a dial, and `gauge-themed` hands an element inside it back to the window's
set (the key hint under a dial). The signal orange is the value set on the emulator, cyan the scan
tool's read-back (always with its triangle shape and a label), amber and red are reserved for zones
and lamps, and text stays in the ink tokens. The pairs were checked for contrast and color-vision
separation on both faces; re-check before changing them. A focused gauge strengthens with the
`*-focus` ink and tick tokens; keyboard focus adds a thin `focus-ring` circle on the dial, never a
box around the gauge.

## Color

Every color is an `oklch()` token in `index.css`: `:root` holds light, `.dark` holds dark, and the
theme follows the `.dark` class on `<html>`. A `.dark` class on a subtree makes everything inside
it dark. Shell surfaces are `window`, `toolbar`, `pane`,
`pane-sunken` and `separator`; `signal` is the one accent, for needles, the active state and primary
actions. Use `text-signal` for icons and short emphasis, never body text. Focus uses `ring`, a
neutral, not the signal.

## Window shell

The app is a desktop window: `html` and `body` never scroll, panes scroll on their own.
[`components/shell`](../../apps/web/src/components/shell) holds the window's primitives at desktop
density (11–13px text, 26–28px controls): `Toolbar`, `Infobar`, `StatusBar`, `Pane` and its
header, `Drawer`, `Inspector` with `InspectorGroup`, `PropertyRow` and `SegmentedControl`. There
are no cards: group settings in inspector groups and data in panes.

In the desktop app the toolbar is the title bar: it carries the `drag-region` utility, and
`useWindowChrome()` says whether the window has macOS traffic lights, from Tauri's injected
globals. The Tauri shell overlays the toolbar on macOS only, where its initialization script makes
`drag-region` drag the window; on Windows and Linux it keeps the native title bar. The shell
exposes nothing but `window.fme` from
[`lib/desktopBridge.ts`](../../apps/web/src/lib/desktopBridge.ts).

The desktop window loads the web app from a fixed origin (Tauri's own asset protocol), not from the
bundled server (a new port each launch), so localStorage and `usePersistentState` survive
restarts. The RPC client connects to the server through `window.fme.serverUrl`.

`useAppearance()` is System, Light or Dark. The browser keeps it in localStorage; the desktop app
keeps it in the native shell, which applies it before the window loads and sets the window theme,
so the page only ever follows `prefers-color-scheme`. The inline script in `index.html` applies it
before first paint. The round dials stay dark in both.
