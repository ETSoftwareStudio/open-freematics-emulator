import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http";

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
