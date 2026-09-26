import { test } from "node:test";
import assert from "node:assert/strict";
import { describeService } from "../discovery.js";

test("mDNS hints require the expected protocol, TLS, valid host and port, and never confer trust", () => {
  const service = {
    name: "LAN board",
    host: "mac.local.",
    port: 4318,
    txt: {
      protocol: "1",
      version: "0.1.0",
      tls: "1",
      token: "must-never-be-returned",
    },
    addresses: ["192.168.1.229", "fe80::1", "not-an-address"],
  };
  const board = describeService(service)!;
  assert.equal(board.url, "https://mac.local:4318");
  assert.equal(board.authenticated, false);
  assert.deepEqual(board.addresses, ["192.168.1.229", "fe80::1"]);
  assert.ok(!JSON.stringify(board).includes("must-never"));
  assert.equal(
    describeService({ ...service, host: "attacker.example/path" }),
    null,
  );
  assert.equal(
    describeService({ ...service, host: "user@attacker.example" }),
    null,
  );
  assert.equal(describeService({ ...service, host: "bad..local" }), null);
  assert.equal(describeService({ ...service, port: 70000 }), null);
  assert.equal(
    describeService({ ...service, txt: { protocol: "2", tls: "1" } }),
    null,
  );
  assert.equal(
    describeService({ ...service, txt: { protocol: "1", tls: "0" } }),
    null,
  );
});
