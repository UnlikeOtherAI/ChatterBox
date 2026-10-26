import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "../client.js";

test("SSE changes survive split data fields and coalesced frames", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("da");
    setImmediate(() =>
      res.end(
        "ta: changed\r\n\r\n: heartbeat\n\ndata: second\ndata: extra\n\n",
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    let changed = 0;
    await new Client(`http://127.0.0.1:${address.port}`, "test").events(
      new AbortController().signal,
      () => {
        changed++;
      },
    );
    assert.equal(changed, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
