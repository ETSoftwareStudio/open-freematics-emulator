// @effect-diagnostics nodeBuiltinImport:off - NodeHttpServer takes a Node http.Server factory.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import * as SerialPorts from "./device/SerialPorts.ts";
import * as SimulatedDevice from "./device/SimulatedDevice.ts";
import * as TcpSockets from "./device/TcpSockets.ts";
import * as EmulatorSession from "./emulator/EmulatorSession.ts";
import * as FirmwareUpdater from "./firmware/FirmwareUpdater.ts";
import * as Http from "./http.ts";
import * as ObdReader from "./obd/ObdReader.ts";
import * as PresetStore from "./presets/PresetStore.ts";
import * as TrafficLog from "./traffic/TrafficLog.ts";
import * as Ws from "./ws.ts";

export interface ServerOptions {
  readonly host: string;
  readonly port: number;
  /** Built web app to serve; `null` in dev, where Vite serves it. */
  readonly webRoot: string | null;
  /** Where user presets are saved. */
  readonly dataDir: string;
  /** Whether the firmware updater may flash a real MK2. */
  readonly hardwareFlash: boolean;
}

export const makeLayer = (options: ServerOptions) =>
  HttpRouter.serve(
    Layer.mergeAll(
      Ws.layer,
      Http.healthLayer,
      options.webRoot === null ? Layer.empty : Http.staticLayer(options.webRoot),
    ),
  ).pipe(
    Layer.provide(PresetStore.layer({ dataDir: options.dataDir })),
    Layer.provide(FirmwareUpdater.layerWith({ realHardware: options.hardwareFlash })),
    Layer.provide(Layer.mergeAll(EmulatorSession.layer, ObdReader.layer)),
    Layer.provide(SimulatedDevice.layer),
    Layer.provide(Layer.mergeAll(SerialPorts.layer, TcpSockets.layer)),
    Layer.provide(TrafficLog.layer),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      NodeHttpServer.layer(() => NodeHttp.createServer(), {
        host: options.host,
        port: options.port,
        // Clients hold long-lived subscriptions; commands finish in milliseconds.
        gracefulShutdownTimeout: "1 second",
      }),
    ),
  );
