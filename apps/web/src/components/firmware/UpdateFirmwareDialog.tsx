import { Progress } from "@base-ui/react/progress";
import {
  MAX_FIRMWARE_IMAGE_LENGTH,
  type FirmwareImageSummary,
  type FirmwareUpdateStage,
  type FirmwareUpdateState,
} from "@fme/contracts";
import { LATEST_OFFICIAL_FIRMWARE } from "@fme/shared/firmware";
import { CircleAlertIcon, CircleCheckIcon, SquareArrowOutUpRightIcon } from "lucide-react";
import { useRef, useState } from "react";
import type * as React from "react";
import { useEmulatorTarget } from "~/components/emulator/ConnectionControls";
import { PropertyRow } from "~/components/shell/PropertyRow";
import { Button } from "~/components/ui/button";
import { Dialog, DialogFooter } from "~/components/ui/dialog";
import { inspectFirmwareAtom, updateFirmwareAtom } from "~/rpc/atoms";
import { useCall, useFirmwareUpdateState } from "~/rpc/hooks";
import { MAX_KEY_FILE_BYTES, parseWireKeyFile } from "./wireKey";

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

interface Run {
  /** The server's update state when this run started; anything else came from this run. */
  readonly baseline: FirmwareUpdateState | null;
  readonly outcome: null | { readonly ok: true } | { readonly ok: false; readonly message: string };
}

const hex = (address: number) => `0x${address.toString(16).toUpperCase().padStart(8, "0")}`;
const bytes = (count: number) => `${count.toLocaleString("en-US")} bytes`;

function FileButton({
  accept,
  onFile,
  children,
}: {
  accept?: string;
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
      <Button size="xs" variant="outline" onClick={() => input.current?.click()}>
        {children}
      </Button>
    </>
  );
}

function VendorUpdaterLink() {
  return (
    <a
      href={LATEST_OFFICIAL_FIRMWARE.downloadUrl}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1.5 font-medium text-info-foreground hover:underline"
    >
      <SquareArrowOutUpRightIcon className="size-3.5" />
      Official firmware & updater
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

/** The dialog's steps. Unmounts when the dialog closes, which drops the image and the key. */
function UpdateFlow({
  onBusyChange,
  onClose,
}: {
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
}) {
  const emulator = useEmulatorTarget();
  const updateState = useFirmwareUpdateState();
  const inspect = useCall(inspectFirmwareAtom);
  const update = useCall(updateFirmwareAtom);
  const [step, setStep] = useState<"choose" | "confirm" | "update">("choose");
  const [image, setImage] = useState<Image | null>(null);
  const [key, setKey] = useState<{ readonly name: string; readonly hex: string | null } | null>(
    null,
  );
  const [run, setRun] = useState<Run>({ baseline: null, outcome: null });
  const serial = emulator.connectTarget._tag === "serial";
  const ready = image?.status === "ready" && key?.hex != null;

  const pickImage = async (file: File) => {
    if (file.size > MAX_FIRMWARE_IMAGE_LENGTH) {
      setImage({ name: file.name, status: "invalid", message: "This file is too large." });
      return;
    }
    const text = await file.text();
    setImage({ name: file.name, status: "checking", text });
    const result = await inspect({ image: text });
    setImage((current) =>
      current?.status !== "checking" || current.text !== text
        ? current
        : result.ok
          ? { name: file.name, status: "ready", text, summary: result.value }
          : { name: file.name, status: "invalid", message: result.message },
    );
  };

  const pickKey = async (file: File) => {
    const hex =
      file.size > MAX_KEY_FILE_BYTES
        ? null
        : parseWireKeyFile(new Uint8Array(await file.arrayBuffer()));
    setKey({ name: file.name, hex });
  };

  const start = async () => {
    if (image?.status !== "ready" || key?.hex == null) return;
    const target = emulator.connectTarget;
    // Keeps the picker on the flashed device once the update disconnects it.
    emulator.choose(emulator.selected);
    setRun({ baseline: updateState, outcome: null });
    setStep("update");
    onBusyChange(true);
    const result = await update({ target, image: image.text, wireKey: key.hex });
    onBusyChange(false);
    setRun((current) => ({
      ...current,
      outcome: result.ok ? { ok: true } : { ok: false, message: result.message },
    }));
  };

  if (step === "choose") {
    return (
      <>
        <div className="mt-3 flex flex-col gap-2">
          <PropertyRow label="Device">{emulator.label}</PropertyRow>
          <div>
            <PropertyRow label="Firmware image" detail={image?.name ?? "Intel HEX (.hex)"}>
              <FileButton accept=".hex" onFile={(file) => void pickImage(file)}>
                {image === null ? "Choose…" : "Change…"}
              </FileButton>
            </PropertyRow>
            {image?.status === "checking" ? (
              <p className="text-muted-foreground">Checking…</p>
            ) : image?.status === "ready" ? (
              <p className="text-muted-foreground tabular-nums">
                {hex(image.summary.start)}–{hex(image.summary.end - 1)} ·{" "}
                {bytes(image.summary.bytes)}
              </p>
            ) : image?.status === "invalid" ? (
              <p className="text-error-foreground">{image.message}</p>
            ) : null}
          </div>
          <div>
            <PropertyRow label="Wire key" detail={key?.name ?? "16 bytes, or 32 hex digits"}>
              <FileButton onFile={(file) => void pickKey(file)}>
                {key === null ? "Choose…" : "Change…"}
              </FileButton>
            </PropertyRow>
            {key !== null && key.hex === null ? (
              <p className="text-error-foreground">
                This file isn't a 16-byte key or 32 hex digits.
              </p>
            ) : null}
            <p className="text-subtle-foreground">
              The key is sent with this update only. It isn't stored.
            </p>
          </div>
          {serial ? (
            <div className="flex flex-col gap-1.5 text-warning-foreground">
              <p>Flashing a real MK2 from this app is locked for now. Use Freematics' updater.</p>
              <VendorUpdaterLink />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" size="xs" onClick={onClose}>
            Cancel
          </Button>
          <Button size="xs" disabled={!ready} onClick={() => setStep("confirm")}>
            Continue…
          </Button>
        </DialogFooter>
      </>
    );
  }

  if (step === "confirm") {
    return (
      <>
        <div className="mt-3 flex flex-col gap-1.5">
          <p className="text-foreground">
            Update {emulator.label} with {image?.name}?
          </p>
          <p className="text-muted-foreground">
            This disconnects the emulator, erases its application and writes the new one. The
            bootloader isn't touched, so a failed update can be run again.
          </p>
          <p className="text-muted-foreground">Keep the device powered until it finishes.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" size="xs" onClick={() => setStep("choose")}>
            Back
          </Button>
          <Button variant="destructive" size="xs" onClick={() => void start()}>
            Erase and Update
          </Button>
        </DialogFooter>
      </>
    );
  }

  const live = updateState !== run.baseline ? updateState : null;

  if (run.outcome === null) {
    const progress = live?._tag === "running" ? live : null;
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

  if (run.outcome.ok) {
    const result = live?._tag === "succeeded" ? live : null;
    const written = result?.bytes ?? (image?.status === "ready" ? image.summary.bytes : null);
    return (
      <>
        <Outcome tone="success" title="Firmware updated.">
          <p className="text-muted-foreground">
            {written !== null ? `Wrote ${bytes(written)}` : "Done"}
            {result?.version != null ? ` (application V${result.version}).` : "."}
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

  const erased = live?._tag === "failed" && live.applicationErased;
  return (
    <>
      <Outcome tone="error" title="Update failed.">
        <p className="text-muted-foreground">{run.outcome.message}</p>
        {erased ? (
          <p className="text-foreground">
            The application was erased, so the emulator won't run until an update succeeds. The
            bootloader is intact: you can run the update again.
          </p>
        ) : null}
        {serial ? (
          <>
            <p className="text-muted-foreground">For a real MK2, use Freematics' updater.</p>
            <VendorUpdaterLink />
          </>
        ) : null}
      </Outcome>
      <DialogFooter>
        <Button variant="outline" size="xs" onClick={() => setStep("choose")}>
          Back
        </Button>
        <Button size="xs" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}

/** Flashes an application image through the MK2 bootloader. */
export function UpdateFirmwareButton() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const updating = useFirmwareUpdateState()?._tag === "running";
  const locked = busy || updating;
  return (
    <>
      <Button size="micro" variant="outline" onClick={() => setOpen(true)}>
        Update Firmware…
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next || !locked) setOpen(next);
        }}
        title="Update Firmware"
        description="Writes an application image through the MK2 bootloader."
        className="w-96"
      >
        <UpdateFlow onBusyChange={setBusy} onClose={() => setOpen(false)} />
      </Dialog>
    </>
  );
}
