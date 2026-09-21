import { once } from "node:events";
import http from "node:http";

import { sanitizeForAgent } from "../security.js";
import { DASHBOARD_HTML } from "./dashboard.js";
import type { ServedSnapshot, StatusSnapshotCache } from "./snapshot.js";

export const DEFAULT_SERVE_PORT = 42_843;

export interface ServeServerOptions {
  cache: Pick<StatusSnapshotCache, "get">;
  host?: string;
  port?: number;
}

export interface ServeServer {
  close: () => Promise<void>;
  /** Resolves once the socket is bound; rejects on bind failure. */
  listen: () => Promise<{ host: string; port: number; url: string }>;
}

const respondJson = (
  response: http.ServerResponse,
  status: number,
  body: unknown
): void => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
};

const handle = async (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  cache: Pick<StatusSnapshotCache, "get">
): Promise<void> => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const route = `${request.method ?? "GET"} ${url.pathname}`;

  if (route === "GET /" || route === "GET /index.html") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
    response.end(DASHBOARD_HTML);
    return;
  }

  if (route === "GET /api/status") {
    let snapshot: ServedSnapshot;
    try {
      snapshot = await cache.get();
    } catch (error) {
      respondJson(response, 500, {
        error: {
          code: "serve/collection-failed",
          message:
            error instanceof Error
              ? sanitizeForAgent(error.message)
              : "Failed.",
        },
        ok: false,
      });
      return;
    }
    respondJson(response, 200, {
      data: sanitizeForAgent(snapshot.result.data),
      generatedAt: new Date(snapshot.fetchedAt).toISOString(),
      ok: true,
    });
    return;
  }

  respondJson(response, 404, {
    error: { code: "serve/not-found", message: `No route: ${route}` },
    ok: false,
  });
};

const dispatch = async (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  cache: Pick<StatusSnapshotCache, "get">
): Promise<void> => {
  try {
    await handle(request, response, cache);
  } catch {
    if (response.headersSent) {
      response.end();
      return;
    }
    respondJson(response, 500, {
      error: { code: "serve/internal", message: "Request failed." },
      ok: false,
    });
  }
};

export const createServeServer = (options: ServeServerOptions): ServeServer => {
  const host = options.host ?? "127.0.0.1";
  const server = http.createServer((request, response) => {
    void dispatch(request, response, options.cache);
  });

  return {
    close: async (): Promise<void> => {
      server.close();
      try {
        await once(server, "close");
      } catch {
        // A socket that never finished binding has nothing left to close.
      }
    },
    listen: async (): Promise<{ host: string; port: number; url: string }> => {
      const port = options.port ?? DEFAULT_SERVE_PORT;
      server.listen(port, host);
      try {
        await once(server, "listening");
      } catch (error) {
        server.close();
        throw error;
      }
      const address = server.address();
      const boundPort =
        typeof address === "object" && address !== null ? address.port : port;
      return { host, port: boundPort, url: `http://${host}:${boundPort}` };
    },
  };
};
