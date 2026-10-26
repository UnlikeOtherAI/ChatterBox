import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  connectAppServer,
  checkAppServerUrl,
  steerExistingTurn,
  type Rpc,
} from "../codex-steer.js";
import type { Claimed } from "../adapter.js";

const native = randomUUID();
const message = {
  message_id: "msg-test",
  body: "Review the revised plan",
  from_alias: "peer",
} as Claimed;
function mock(
  loaded = true,
  status = "inProgress",
  returnedTurn = "active-turn",
) {
  const calls: { method: string; params: unknown }[] = [];
  const call: Rpc = async <T>(method: string, params: unknown) => {
    calls.push({ method, params });
    return {
      "thread/loaded/list": { data: loaded ? [native] : [], nextCursor: null },
      "thread/turns/list": { data: [{ id: "active-turn", status }] },
      "turn/steer": { turnId: returnedTurn },
    }[method] as T;
  };
  return { call, calls };
}
test("steer targets only an exact loaded thread and expected active turn, without starting a runtime", async () => {
  const m = mock();
  const receipt = await steerExistingTurn(m.call, native, message);
  assert.equal(receipt.state, "steer_accepted");
  assert.match(receipt.detail, /agent acknowledgement pending/);
  assert.deepEqual(
    m.calls.map((c) => c.method),
    ["thread/loaded/list", "thread/turns/list", "turn/steer"],
  );
  const params = m.calls[2]!.params as {
    threadId: string;
    expectedTurnId: string;
    input: { text: string }[];
  };
  assert.equal(params.threadId, native);
  assert.equal(params.expectedTurnId, "active-turn");
  assert.match(params.input[0]!.text, /msg-test/);
});
test("idle, unloaded, malformed or changed turns stay pending rather than resuming, starting or queueing", async () => {
  for (const m of [mock(false), mock(true, "completed")]) {
    await assert.rejects(steerExistingTurn(m.call, native, message));
    assert.ok(m.calls.every((c) => c.method !== "turn/steer"));
  }
  const m = mock();
  await assert.rejects(
    steerExistingTurn(m.call, "session-title", message),
    /exact native UUID/,
  );
  assert.equal(m.calls.length, 0);
  await assert.rejects(
    steerExistingTurn(
      mock(true, "inProgress", "different-turn").call,
      native,
      message,
    ),
    /outcome is unknown/,
  );
});
test("steering endpoints are explicit loopback connections without URL credentials", () => {
  assert.equal(
    checkAppServerUrl("ws://127.0.0.1:4319"),
    "ws://127.0.0.1:4319/",
  );
  for (const url of [
    "ws://192.168.1.90:4319",
    "wss://example.com",
    "ws://user:secret@localhost:4319",
    "ws://localhost:4319/?token=secret",
    "http://localhost:4319",
  ])
    assert.throws(() => checkAppServerUrl(url));
});

test("steering deadline prevents mutation after slow loaded-thread pagination", async () => {
  const methods: string[] = [];
  const call: Rpc = async <T>(method: string) => {
    methods.push(method);
    await new Promise((resolve) => setTimeout(resolve, 15));
    return { data: [], nextCursor: "next-page" } as T;
  };
  await assert.rejects(
    steerExistingTurn(call, native, message, Date.now() + 5010),
    /deadline/,
  );
  assert.deepEqual(methods, ["thread/loaded/list"]);
});

test("shared-runtime sidecar ignores approval requests even when IDs collide with its RPC", async () => {
  const incoming: Record<string, unknown>[] = [];
  const sockets = new Set<import("node:stream").Duplex>();
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const accept = createHash("sha1")
      .update(
        `${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
      )
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const send = (message: unknown) => {
      const payload = Buffer.from(JSON.stringify(message));
      const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
      header[0] = 0x81;
      if (payload.length < 126) header[1] = payload.length;
      else {
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
      }
      socket.write(Buffer.concat([header, payload]));
    };
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0]! & 15;
        let length = buffer[1]! & 127;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        }
        if (length === 127) {
          socket.destroy();
          return;
        }
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(
          buffer.subarray(offset + 4, offset + 4 + length),
        );
        buffer = buffer.subarray(offset + 4 + length);
        if (opcode === 8) {
          socket.end();
          return;
        }
        for (let n = 0; n < payload.length; n++)
          payload[n] = payload[n]! ^ mask[n % 4]!;
        const message = JSON.parse(payload.toString()) as Record<
          string,
          unknown
        >;
        incoming.push(message);
        if (message.method === "initialize")
          send({
            id: message.id,
            result: { userAgent: "test/0.159.2", platformFamily: "windows" },
          });
        if (message.method === "thread/loaded/list") {
          send({
            id: message.id,
            method: "item/commandExecution/requestApproval",
            params: { threadId: native },
          });
          setTimeout(
            () =>
              send({
                id: message.id,
                result: { data: [native], nextCursor: null },
              }),
            10,
          );
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  let connection: Awaited<ReturnType<typeof connectAppServer>> | undefined;
  try {
    connection = await connectAppServer(`ws://127.0.0.1:${port}`);
    const result = await connection.call<{ data: string[] }>(
      "thread/loaded/list",
      {},
    );
    assert.deepEqual(result.data, [native]);
    assert.ok(
      incoming.every(
        (message) => !("result" in message) && !("error" in message),
      ),
      "sidecar must never answer owner-runtime requests",
    );
  } finally {
    connection?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
