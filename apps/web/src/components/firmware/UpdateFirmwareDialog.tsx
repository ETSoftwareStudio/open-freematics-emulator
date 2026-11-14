import { Progress } from "@base-ui/react/progress";
import { useAtom, useAtomSet } from "@effect/atom-react";
import {
  MAX_FIRMWARE_IMAGE_LENGTH,
  type FirmwareImageSource,
  type FirmwareImageSummary,
  type FirmwareUpdateInput,
  type FirmwareUpdateStage,
  type LibraryImage,
} from "@fme/contracts";
import { LATEST_OFFICIAL_FIRMWARE } from "@fme/shared/firmware";
import * as Atom from "effect/reactivity/Atom";
import { CircleAlertIcon, CircleCheckIcon, SquareArrowOutUpRightIcon } from "lucide-react";
import { useRef, useState } from "react";
import type * as React from "react";
import { useEmulatorTarget } from "~/components/emulator/ConnectionControls";
import { PropertyRow } from "~/components/shell/PropertyRow";
import { Button } from "~/components/ui/button";
import { Dialog, DialogFooter } from "~/components/ui/dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  forgetWireKeyAtom,
  downloadVendorFirmwareAtom,
  importVendorFilesAtom,
  inspectFirmwareAtom,
  updateFirmwareAtom,
} from "~/rpc/atoms";
import { useCall, useFirmwareLibrary, useFirmwareUpdateState, useWireKeyStatus } from "~/rpc/hooks";
import { targetAge } from "./targetAge";
import { updateView, type UpdateRun, type UpdateView } from "./updateView";
import { importVendorFolder } from "./vendorFolder";

/** Whether the user asked for the dialog; the buttons that open it may unmount under it. */
const updateDialogOpenAtom = Atom.make(false).pipe(Atom.keepAlive);

const STAGES: Record<FirmwareUpdateStage, string> = {
  entering: "Restarting into the bootloader…",
  handshake: "Waiting for the bootloader…",
  reading: "Reading the device…",
  erasing: "Erasing the application…",
  writing: "Writing the application…",
  finishing: "Finishing…",
};

type Image =
  | { readonly name: string; readonly status: "checking"; readonly text: string }
  | {
      readonly name: string;
      readonly status: "ready";
      readonly text: string;
      readonly summary: FirmwareImageSummary;
    }
  | { readonly name: string; readonly status: "invalid"; readonly message: string };

type Step = "choose" | "confirm" | "update";

interface Flow {
  readonly step: Step;
  readonly run: UpdateRun;
}

const START: Flow = { step: "choose", run: { baseline: null, outcome: null } };

const hex = (address: number) => `0x${address.toString(16).toUpperCase().padStart(8, "0")}`;
const bytes = (count: number) => `${count.toLocaleString("en-US")} bytes`;

function FileButton({
  accept,
  disabled,
  onFile,
  children,
}: {
  accept?: string;
  disabled?: boolean;
  onFile: (file: File) => void;
  children: React.ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file !== undefined) onFile(file);
        }}
      />
      <Button
        size="xs"
        variant="outline"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        {children}
      </Button>
    </>
  );
}

/** Picks a whole folder; the browser hands over every file in it. */
function FolderButton({
  onFiles,
  disabled,
  children,
}: {
  onFiles: (files: ReadonlyArray<File>) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input
        ref={(element) => {
          input.current = element;
          if (element !== null) element.webkitdirectory = true;
        }}
        type="file"
        hidden
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
      <Button
        size="xs"
        variant="outline"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        {children}
      </Button>
    </>
  );
}

const libraryLabel = (image: LibraryImage) =>
  [image.version !== null ? `V${image.version}` : image.name, image.released]
    .filter((part) => part !== null)
    .join(" · ");

function OfficialFirmwareLink() {
  return (
    <a
      href={LATEST_OFFICIAL_FIRMWARE.downloadUrl}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1.5 font-medium text-info-foreground hover:underline"
    >
      <SquareArrowOutUpRightIcon className="size-3.5" />
      Freematics GUI download (has FirmwareUpdater.exe and the firmware)
    </a>
  );
}

function Outcome({
  tone,
  title,
  children,
}: {
  tone: "success" | "error";
  title: string;
  children: React.ReactNode;
}) {
  const Icon = tone === "success" ? CircleCheckIcon : CircleAlertIcon;
  return (
    <div className="mt-3 flex gap-2">
      <Icon
        className={
          tone === "success"
            ? "size-4 shrink-0 text-success-foreground"
            : "size-4 shrink-0 text-error-foreground"
        }
      />
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="font-medium text-foreground">{title}</p>
        {children}
      </div>
    </div>
  );
}

type Choice =
  | { readonly kind: "library"; readonly name: string }
  | { readonly kind: "file"; readonly image: Image };

/**
 * The dialog's steps. Unmounts when the dialog closes, which drops the chosen image; the step
 * and the run live in the dialog, which stays mounted.
 */
function UpdateFlow({
  step,
  view,
  onStepChange,
  onStart,
  onBusyChange,
  onClose,
}: {
  step: Step;
  /** The run's progress or result during the update step. */
  view: UpdateView | null;
  onStepChange: (step: Step) => void;
  onStart: (input: FirmwareUpdateInput) => void;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
}) {
  const emulator = useEmulatorTarget();
  const wireKey = useWireKeyStatus();
  const library = useFirmwareLibrary();
  const inspect = useCall(inspectFirmwareAtom);
  const importFiles = useCall(importVendorFilesAtom);
  const downloadFirmware = useCall(downloadVendorFirmwareAtom);
  const forgetKey = useCall(forgetWireKeyAtom);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [vendor, setVendor] = useState<{ busy: boolean; note: string | null; error: boolean }>({
    busy: false,
    note: null,
    error: false,
  });
  const age = targetAge(emulator.connection, emulator.connectTarget);

  // The newest library image is the default until something else is picked.
  const chosen: Choice | null =
    choice ?? (library[0] !== undefined ? { kind: "library", name: library[0].name } : null);
  const libraryImage =
    chosen?.kind === "library" ? (library.find((item) => item.name === chosen.name) ?? null) : null;
  const fileImage = chosen?.kind === "file" ? chosen.image : null;
  const summary = libraryImage ?? (fileImage?.status === "ready" ? fileImage.summary : null);
  const chosenLabel = libraryImage !== null ? libraryLabel(libraryImage) : fileImage?.name;

  const pickImage = async (file: File) => {
    if (file.size > MAX_FIRMWARE_IMAGE_LENGTH) {
      setChoice({
        kind: "file",
        image: { name: file.name, status: "invalid", message: "This file is too large." },
      });
      return;
    }
    const text = await file.text();
    setChoice({ kind: "file", image: { name: file.name, status: "checking", text } });
    const result = await inspect({ image: text });
    setChoice((current) =>
      current?.kind !== "file" || current.image.status !== "checking" || current.image.text !== text
        ? current
        : {
            kind: "file",
            image: result.ok
              ? { name: file.name, status: "ready", text, summary: result.value }
              : { name: file.name, status: "invalid", message: result.message },
          },
    );
  };

  const importFolder = async (files: ReadonlyArray<File>) => {
    setVendor({ busy: true, note: null, error: false });
    const outcome = await importVendorFolder(files, importFiles);
    if (outcome.imported) setChoice(null);
    setVendor({ busy: false, note: outcome.note, error: outcome.error });
  };

  const replaceKey = async () => {
    setVendor({ busy: true, note: null, error: false });
    const result = await forgetKey(undefined);
    setVendor({ busy: false, note: result.ok ? null : result.message, error: !result.ok });
  };

  const downloadVendor = async () => {
    setVendor({
      busy: true,
      note: "Downloading and unpacking Freematics GUI (43 MB)…",
      error: false,
    });
    onBusyChange(true);
    try {
      const result = await downloadFirmware(undefined);
      if (!result.ok) {
        setVendor({ busy: false, note: result.message, error: true });
        return;
      }
      setChoice(null);
      setVendor({
        busy: false,
        note: `Imported ${result.value.imagesAdded} firmware images. Nothing has been flashed.`,
        error: false,
      });
    } finally {
      onBusyChange(false);
    }
  };

  const downloadButton = (
    <Button
      size="xs"
      variant="outline"
      disabled={vendor.busy}
      onClick={() => void downloadVendor()}
    >
      Download from Freematics…
    </Button>
  );

  const start = () => {
    const source: FirmwareImageSource | null =
      libraryImage !== null
        ? { _tag: "library", name: libraryImage.name }
        : fileImage?.status === "ready"
          ? { _tag: "file", text: fileImage.text }
          : null;
    if (source === null) return;
    const target = emulator.connectTarget;
    // Keeps the picker on the flashed device once the update disconnects it.
    emulator.choose(emulator.selected);
    onStart({
      target,
      image: source,
      // Starting from the confirm step, under its warning, is the confirmation.
      ...(age.warning === "too-old" ? { confirmTooOld: true } : {}),
    });
  };

  const vendorNote =
    vendor.note !== null ? (
      <p className={vendor.error ? "text-error-foreground" : "text-muted-foreground"}>
        {vendor.note}
      </p>
    ) : null;

  // The key comes first: until one is stored, the dialog only asks for the Freematics folder.
  if (view === null && step === "choose" && wireKey?._tag !== "present") {
    return (
      <>
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-foreground">First, import the Freematics updater and firmware.</p>
          <p className="text-muted-foreground">
            Download directly from Freematics, or choose an installed or unpacked GUI folder. The
            app verifies and unpacks the download without running the Windows installer, then stores
            the wire key and firmware locally. Nothing is flashed at this step.
          </p>
          {downloadButton}
          <PropertyRow label="Freematics folder">
            <FolderButton disabled={vendor.busy} onFiles={(files) => void importFolder(files)}>
              {vendor.busy ? "Reading…" : "Choose…"}
            </FolderButton>
          </PropertyRow>
          {vendorNote}
          <OfficialFirmwareLink />
        </div>
        <DialogFooter>
          <Button variant="outline" size="xs" disabled={vendor.busy} onClick={onClose}>
            Cancel
          </Button>
          <Button size="xs" disabled>
            Continue…
          </Button>
        </DialogFooter>
      </>
    );
  }

  if (view === null && step === "choose") {
    return (
      <>
        <div className="mt-3 flex flex-col gap-2">
          <PropertyRow label="Device">{emulator.label}</PropertyRow>
          <div className="flex flex-col gap-1.5">
            <PropertyRow label="Firmware image">
              {library.length > 0 ? (
                <Select
                  disabled={vendor.busy}
                  value={libraryImage?.name ?? null}
                  onValueChange={(value) => {
                    if (typeof value === "string") setChoice({ kind: "library", name: value });
                  }}
                >
                  <SelectTrigger size="compact" aria-label="Firmware image">
                    <SelectValue>
                      {libraryImage !== null ? libraryLabel(libraryImage) : (fileImage?.name ?? "")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {library.map((item, index) => (
                      <SelectItem key={item.name} value={item.name}>
                        {libraryLabel(item)}
                        {index === 0 ? " (newest)" : ""}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : (
                <span className="text-muted-foreground">{fileImage?.name ?? "None imported"}</span>
              )}
            </PropertyRow>
            {fileImage?.status === "checking" ? (
              <p className="text-muted-foreground">Checking…</p>
            ) : fileImage?.status === "invalid" ? (
              <p className="text-error-foreground">{fileImage.message}</p>
            ) : summary !== null ? (
              <p className="text-muted-foreground tabular-nums">
                {hex(summary.start)}–{hex(summary.end - 1)} · {bytes(summary.bytes)}
              </p>
            ) : null}
            <div className="flex gap-2">
              <FolderButton disabled={vendor.busy} onFiles={(files) => void importFolder(files)}>
                {vendor.busy ? "Reading…" : "Import folder…"}
              </FolderButton>
              <FileButton
                disabled={vendor.busy}
                accept=".hex"
                onFile={(file) => void pickImage(file)}
              >
                Other file…
              </FileButton>
            </div>
            {vendorNote}
            {downloadButton}
          </div>
          <PropertyRow
            label="Wire key"
            detail={wireKey?._tag === "present" ? wireKey.fingerprint.slice(0, 12) : undefined}
          >
            <Button
              size="xs"
              variant="outline"
              disabled={vendor.busy}
              onClick={() => void replaceKey()}
            >
              Replace…
            </Button>
          </PropertyRow>
          <OfficialFirmwareLink />
        </div>
        <DialogFooter>
          <Button variant="outline" size="xs" disabled={vendor.busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="xs"
            disabled={summary === null || vendor.busy}
            onClick={() => onStepChange("confirm")}
          >
            Continue…
          </Button>
        </DialogFooter>
      </>
    );
  }

  if (view === null) {
    return (
      <>
        <div className="mt-3 flex flex-col gap-1.5">
          <p className="text-foreground">
            Update {emulator.label} with {chosenLabel}?
          </p>
          <p className="text-muted-foreground">
            This disconnects the emulator, erases its application and writes the new one. The
            bootloader isn't touched, so a failed update can be run again.
          </p>
          <p className="text-muted-foreground">Keep the device powered until it finishes.</p>
          {age.warning !== null ? (
            <p className="text-warning-foreground">
              Freematics advises against updating units made before 2018.
              {age.made !== null
                ? ` This one was made in ${age.made}.`
                : " This unit's age can't be read."}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" size="xs" onClick={() => onStepChange("choose")}>
            Back
          </Button>
          <Button variant="destructive" size="xs" onClick={start}>
            Erase and Update
          </Button>
        </DialogFooter>
      </>
    );
  }

  if (view._tag === "progress") {
    const progress = view.state;
    return (
      <div className="mt-3 flex flex-col gap-2">
        <Progress.Root
          value={progress !== null && progress.total > 0 ? progress.written : null}
          max={progress?.total ?? 100}
          className="flex flex-col gap-1.5"
        >
          <Progress.Label className="text-foreground">
            {progress !== null ? STAGES[progress.stage] : "Starting…"}
          </Progress.Label>
          <Progress.Track className="h-1.5 overflow-hidden rounded-full bg-muted">
            <Progress.Indicator className="h-full bg-signal transition-[width] duration-150" />
          </Progress.Track>
        </Progress.Root>
        {progress !== null ? (
          <p className="text-muted-foreground tabular-nums">
            {progress.written.toLocaleString("en-US")} of {bytes(progress.total)}
          </p>
        ) : null}
        <p className="text-subtle-foreground">Keep the device powered until it finishes.</p>
      </div>
    );
  }

  if (view._tag === "succeeded") {
    const written = view.bytes ?? summary?.bytes ?? null;
    return (
      <>
        <Outcome tone="success" title="Firmware updated.">
          <p className="text-muted-foreground">
            {written !== null ? `Wrote ${bytes(written)}` : "Done"}
            {view.version !== null ? ` (application V${view.version}).` : "."}
          </p>
          <p className="text-muted-foreground">
            Connect again to use the emulator. A real unit may need a power cycle first.
          </p>
        </Outcome>
        <DialogFooter>
          <Button size="xs" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <Outcome tone="error" title="Update failed.">
        <p className="text-muted-foreground">{view.message}</p>
        {view.applicationErased ? (
          <p className="text-foreground">
            The application was erased, so the emulator won't run until an update succeeds. The
            bootloader is intact: you can run the update again.
          </p>
        ) : null}
      </Outcome>
      <DialogFooter>
        <Button variant="outline" size="xs" onClick={() => onStepChange("choose")}>
          Back
        </Button>
        <Button size="xs" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}

/** Opens the firmware update dialog, which `UpdateFirmwareDialog` mounts once for the app. */
export function UpdateFirmwareButton() {
  const setOpen = useAtomSet(updateDialogOpenAtom);
  return (
    <Button size="micro" variant="outline" onClick={() => setOpen(true)}>
      Update Firmware…
    </Button>
  );
}

/**
 * Flashes an application image through the MK2 bootloader. Mounted once at the app's root: the
 * update disconnects the emulator, which removes the infobar and can remove the inspector that
 * opened it. Progress and result come from the streamed update state, so a running update shows
 * here in every window, also one that was reloaded or didn't start it.
 */
export function UpdateFirmwareDialog() {
  const [requested, setRequested] = useAtom(updateDialogOpenAtom);
  const [flow, setFlow] = useState(START);
  const [busy, setBusy] = useState(false);
  const updateState = useFirmwareUpdateState();
  const update = useCall(updateFirmwareAtom);

  if (updateState?._tag === "running" && flow.step !== "update") {
    setFlow({ step: "update", run: START.run });
  }
  const view = flow.step === "update" ? updateView(updateState, flow.run) : null;
  const locked = busy || view?._tag === "progress";

  const close = () => {
    setRequested(false);
    setFlow(START);
  };
  const start = async (input: FirmwareUpdateInput) => {
    const run: UpdateRun = { baseline: updateState, outcome: null };
    setFlow({ step: "update", run });
    const result = await update(input);
    const outcome = result.ok
      ? { ok: true as const }
      : { ok: false as const, message: result.message };
    setFlow((current) =>
      current.run === run ? { ...current, run: { ...run, outcome } } : current,
    );
  };

  return (
    <Dialog
      open={requested || flow.step === "update"}
      onOpenChange={(next) => {
        if (next) setRequested(true);
        else if (!locked) close();
      }}
      title="Update Firmware"
      description="Writes an application image through the MK2 bootloader."
      className="w-96"
    >
      <UpdateFlow
        step={flow.step}
        view={view}
        onStepChange={(step) => setFlow({ step, run: START.run })}
        onStart={(input) => void start(input)}
        onBusyChange={setBusy}
        onClose={close}
      />
    </Dialog>
  );
}
