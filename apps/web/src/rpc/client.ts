import { WsRpcGroup } from "@fme/contracts";
import * as Layer from "effect/Layer";
import * as AtomRpc from "effect/reactivity/AtomRpc";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import { desktopBridge } from "~/lib/desktopBridge";

// Same origin in dev (Vite proxies /ws) and when the server serves the built app.
const wsUrl =
  desktopBridge?.serverUrl ??
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

export class EmulatorClient extends AtomRpc.Service<EmulatorClient>()("EmulatorClient", {
  group: WsRpcGroup,
  protocol: RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
    Layer.provide(Socket.layerWebSocket(wsUrl)),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.provide(RpcSerialization.layerJson),
  ),
}) {}
