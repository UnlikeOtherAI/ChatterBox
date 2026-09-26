import {
  createServer as httpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as httpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { Board } from "./store.js";
import { BoardError, schemas, type Method, type Principal } from "./types.js";

export async function serve(
  board: Board,
  options: { port?: number; host?: string; cert?: string; key?: string } = {},
) {
  const host = options.host ?? "127.0.0.1";
  if (
    !["127.0.0.1", "::1", "localhost"].includes(host) &&
    !(options.cert && options.key)
  )
    throw new Error("A network listener requires --cert and --key for TLS");
  const clients = new Set<{
    response: ServerResponse;
    principal: Principal;
    token: string;
  }>();
  const rates = new Map<string, { start: number; count: number }>();
  const json = (res: ServerResponse, code: number, data: unknown) => {
    res.writeHead(code, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify(data));
  };
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.headers.origin)
        throw new BoardError(403, "Browser-origin API calls are disabled");
      const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      const p = board.authenticate(token);
      const rate = rates.get(p.id) ?? { start: Date.now(), count: 0 };
      if (Date.now() - rate.start > 60000) {
        rate.start = Date.now();
        rate.count = 0;
      }
      rate.count++;
      rates.set(p.id, rate);
      if (rate.count > 600)
        throw new BoardError(
          429,
          "Request limit exceeded; retry in one minute",
        );
      if (req.url === "/events" && req.method === "GET") {
        if ([...clients].filter((c) => c.principal.id === p.id).length >= 16)
          throw new BoardError(
            429,
            "Too many event streams for this credential",
          );
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        res.write("data: connected\n\n");
        const entry = { response: res, principal: p, token };
        clients.add(entry);
        req.on("close", () => clients.delete(entry));
        return;
      }
      if (req.url === "/health" && req.method === "GET") {
        json(res, 200, {
          status: "ok",
          version: "0.1.0",
          workspace_id: p.workspace_id,
          project_id: p.project_id,
        });
        return;
      }
      const method = req.url?.match(/^\/api\/([a-z]+)$/)?.[1] as
        Method | undefined;
      if (req.method !== "POST" || !method || !Object.hasOwn(schemas, method))
        throw new BoardError(404, "Unknown endpoint");
      if (!req.headers["content-type"]?.startsWith("application/json"))
        throw new BoardError(415, "Use application/json");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > 128 * 1024)
          throw new BoardError(413, "Request exceeds 128 KiB");
        chunks.push(chunk as Buffer);
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        throw new BoardError(400, "Invalid JSON");
      }
      const result = board.call(p, method, body, token);
      json(res, 200, result);
      if (
        [
          "send",
          "broadcast",
          "ack",
          "status",
          "register",
          "report",
          "embed",
        ].includes(method)
      ) {
        for (const client of clients)
          if (
            client.principal.workspace_id === p.workspace_id &&
            client.principal.project_id === p.project_id
          ) {
            if (client.response.writableLength > 65536)
              client.response.destroy();
            else client.response.write("data: changed\n\n");
          }
      }
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof BoardError)
        json(res, error.status, {
          error: error.message,
          details: error.details,
        });
      else {
        console.error(
          "Board operation failed:",
          error instanceof Error ? error.message : "unknown error",
        );
        json(res, 500, { error: "Board operation failed" });
      }
    }
  };
  const server =
    options.cert && options.key
      ? httpsServer(
          { cert: readFileSync(options.cert), key: readFileSync(options.key) },
          (req, res) => {
            void handler(req, res);
          },
        )
      : httpServer((req, res) => {
          void handler(req, res);
        });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const timer = setInterval(() => {
    for (const c of clients) {
      try {
        board.authenticate(c.token);
        c.response.write(": heartbeat\n\n");
      } catch {
        c.response.end();
        clients.delete(c);
      }
    }
    for (const [id, rate] of rates)
      if (Date.now() - rate.start > 120000) rates.delete(id);
  }, 15000);
  timer.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4318, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    server,
    port: typeof address === "object" && address ? address.port : 0,
    close: async () => {
      clearInterval(timer);
      for (const c of clients) c.response.end();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
