import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse, HttpStaticServer } from "effect/http";

const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Browsers let any web page open a WebSocket to this server, so a browser request must come from a
 * page this server served: same origin, on a loopback host (which also defeats DNS rebinding).
 * No `Origin` means a local non-browser client such as `hardware:check`.
 */
export const isLocalRequest = (headers: Readonly<Record<string, string | undefined>>) => {
  const host = headers.host === undefined ? null : URL.parse(`http://${headers.host}`);
  if (host === null || !loopbackHostnames.has(host.hostname)) return false;
  if (headers.origin === undefined) return true;
  const origin = URL.parse(headers.origin);
  return origin !== null && origin.protocol === "http:" && origin.host === host.host;
};

export const localOnlyLayer = HttpRouter.middleware(
  (app) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (isLocalRequest(request.headers)) return yield* app;
      yield* Effect.logWarning("Rejected a request from another origin", {
        host: request.headers.host,
        origin: request.headers.origin,
      });
      return HttpServerResponse.empty({ status: 403 });
    }),
  { global: true },
);

export const healthLayer = HttpRouter.add(
  "GET",
  "/api/health",
  HttpServerResponse.json({ ok: true }),
);

/** Serves the built web app. In dev Vite serves it and proxies `/ws` here instead. */
export const staticLayer = (webRoot: string) =>
  HttpStaticServer.layer({ root: webRoot, index: "index.html" }).pipe(
    Layer.catchCause((cause) =>
      Layer.effectDiscard(Effect.logWarning("Web assets unavailable; serving the API only", cause)),
    ),
  );
