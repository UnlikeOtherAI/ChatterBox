import type { Claimed } from "./adapter.js";
import { envelope } from "./adapter.js";

export class DeliveryError extends Error {}

export type Rpc = <T>(method: string, params: unknown) => Promise<T>;
export type NativeReceipt = {
  state: "steer_accepted";
  detail: string;
};

// Attach only to a deliberately shared endpoint. Never spawn or resume a runtime.
export function checkAppServerUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "ws:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new DeliveryError(
      "App-server steering requires an explicit loopback ws:// endpoint; use an existing SSH tunnel across hosts",
    );
  return url.href;
}

export async function connectAppServer(value: string) {
  const socket = new WebSocket(checkAppServerUrl(value));
  let sequence = 0;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      method: string;
    }
  >();
  const rejectAll = () => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(
        new DeliveryError(
          "App-server connection closed; delivery outcome may be unknown",
        ),
      );
    }
    pending.clear();
  };
  socket.addEventListener("close", rejectAll);
  socket.addEventListener("error", rejectAll);
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        result?: unknown;
        error?: unknown;
      };
      // This sidecar never owns approval/tool requests. The native owner handles
      // them; responding here could reject or steal another client's request.
      if (message.method) return;
      const p = message.id === undefined ? undefined : pending.get(message.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(message.id!);
      // Provider errors can contain private content. Keep it out of board reports.
      if (message.error)
        p.reject(
          new DeliveryError(
            `App-server rejected ${p.method}; exact thread or active turn may have changed`,
          ),
        );
      else p.resolve(message.result);
    } catch {
      socket.close();
      rejectAll();
    }
  });
  const close = () => {
    rejectAll();
    socket.close();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new DeliveryError("App-server connection timed out"));
        socket.close();
      }, 5000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new DeliveryError("App-server endpoint unavailable"));
        },
        { once: true },
      );
    });
    const call: Rpc = <T>(method: string, params: unknown) =>
      new Promise<T>((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) {
          reject(new DeliveryError("App-server endpoint closed"));
          return;
        }
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new DeliveryError(
              "App-server request timed out; delivery outcome may be unknown",
            ),
          );
        }, 5000);
        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
          timer,
          method,
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    const initialized = await call<{
      userAgent: string;
      platformFamily: string;
    }>("initialize", {
      clientInfo: { name: "chatterbox", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    socket.send(JSON.stringify({ method: "initialized" }));
    return {
      call,
      close,
      userAgent: initialized.userAgent,
      platformFamily: initialized.platformFamily,
    };
  } catch (error) {
    close();
    throw error;
  }
}

export async function steerExistingTurn(
  call: Rpc,
  nativeId: string,
  message: Claimed,
  deadline = Date.now() + 15000,
): Promise<NativeReceipt> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      nativeId,
    )
  )
    throw new DeliveryError("Steering requires an exact native UUID");
  const checkDeadline = () => {
    if (Date.now() + 5000 >= deadline)
      throw new DeliveryError(
        "Steering deadline reached before native mutation; mailbox recovery remains available",
      );
  };
  let cursor: string | null = null;
  let loaded = false;
  for (let page = 0; page < 100; page++) {
    checkDeadline();
    const result: { data: string[]; nextCursor: string | null } = await call(
      "thread/loaded/list",
      { cursor, limit: 100 },
    );
    if (result.data.includes(nativeId)) {
      loaded = true;
      break;
    }
    if (!result.nextCursor || result.nextCursor === cursor) break;
    cursor = result.nextCursor;
  }
  if (!loaded)
    throw new DeliveryError(
      "Exact native thread is not loaded on this endpoint; mailbox recovery remains available",
    );
  checkDeadline();
  const { data } = await call<{ data: { id: string; status: string }[] }>(
    "thread/turns/list",
    {
      threadId: nativeId,
      limit: 1,
      sortDirection: "desc",
      itemsView: "notLoaded",
    },
  );
  const active = data[0];
  if (!active || active.status !== "inProgress")
    throw new DeliveryError(
      "Native thread has no active turn; message remains pending for explicit mailbox recovery or a later active turn",
    );
  checkDeadline();
  const result = await call<{ turnId: string }>("turn/steer", {
    threadId: nativeId,
    expectedTurnId: active.id,
    input: [{ type: "text", text: envelope(message), text_elements: [] }],
  });
  if (result.turnId !== active.id)
    throw new DeliveryError(
      "App-server returned a different turn ID; delivery outcome is unknown",
    );
  return {
    state: "steer_accepted",
    detail: `Native turn/steer accepted for turn ${active.id}; agent acknowledgement pending`,
  };
}

export async function codexSteer(
  url: string,
  nativeId: string,
  message: Claimed,
) {
  const deadline = Date.now() + 20000;
  const connection = await connectAppServer(url);
  try {
    // CLI version discovery alone cannot establish the version of a shared server.
    if (
      !/\/0\.159\.2(?: |$)/.test(connection.userAgent) ||
      connection.platformFamily !== "windows"
    )
      throw new DeliveryError(
        "Shared app-server version/platform has no ChatterBox steering proof",
      );
    return await steerExistingTurn(
      connection.call,
      nativeId,
      message,
      deadline,
    );
  } finally {
    connection.close();
  }
}
