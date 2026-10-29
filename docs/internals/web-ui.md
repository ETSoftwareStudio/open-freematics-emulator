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

[`Panel.tsx`](../../apps/web/src/components/emulator/Panel.tsx) exports one object of slots
(`Root`, `Header`, `Title`, `Description`, `Actions`, `Body`). Slots own their classes and spread
the rest of their props. New panels compose those slots instead of copying markup.

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
readouts under them share that behaviour through `useGaugeControl`.
Dial geometry lives in `gaugeGeometry.ts` and is unit-tested; a gauge's display range and zones are
UI choices and may be narrower than what the PID can encode, so the PID list stays the place for
exact values. PID controls share `usePidControl` for drafts and send de-duplication.

The cluster is dark in both themes. Its colors are the `gauge-*` tokens in `index.css`: the signal
orange is the value set on the emulator, cyan the scan tool's read-back (always with its triangle
shape and a label), amber and red are reserved for zones and lamps, and text stays in the ink
tokens. The pairs were checked for color-vision separation on the cluster face; re-check before
changing them. A focused gauge brightens with the `*-focus` ink and tick tokens; keyboard focus
adds a thin `focus-ring` circle on the dial, never a box around the gauge.

## Color

Every color is an `oklch()` token in `index.css`: `:root` holds light, `.dark` holds dark, and the
theme follows the `.dark` class on `<html>`. A `.dark` class on a subtree (the cluster in a light
window) makes everything inside it dark. Shell surfaces are `window`, `toolbar`, `pane`,
`pane-sunken` and `separator`; `signal` is the one accent, for needles, the active state and primary
actions. Use `text-signal` for icons and short emphasis, never body text. Focus uses `ring`, a
neutral, not the signal.

## Window shell

The app is a desktop window: `html` and `body` never scroll, panes scroll on their own.
[`components/shell`](../../apps/web/src/components/shell) holds the window's primitives at desktop
density (11–13px text, 26–28px controls): `Toolbar`, `Infobar`, `StatusBar`, `Pane` and its
header, `Drawer`, `Inspector` with `InspectorGroup`, `PropertyRow` and `SegmentedControl`. Build
screens from them rather than from `Panel`, which is for cards. A `Panel` inside an inspector
group sits in `Panel.Embedded`, which drops its frame and title.

In the desktop app the toolbar is the title bar: it carries the `drag-region` utility, and
`useWindowChrome()` says where the platform's window buttons sit. The renderer is sandboxed, so
the user agent is the only signal; the preload exposes nothing but `window.fme.appearance`.

`useAppearance()` is System, Light or Dark. The browser keeps it in localStorage; the desktop app
keeps it in the main process (the page's origin changes each launch) and sets
`nativeTheme.themeSource`, so the page only ever follows `prefers-color-scheme`. The inline script
in `index.html` applies it before first paint. The instrument cluster stays dark in both.
