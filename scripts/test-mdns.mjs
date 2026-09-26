import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Discovery, advertise } from "../dist/discovery.js";
const name = `ChatterBox discovery test ${randomUUID().slice(0, 8)}`;
const discovery = new Discovery();
const publisher = advertise(44318, { name });
try {
  let found;
  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(250);
    found = discovery.snapshot().boards.find((b) => b.name === name);
    if (found) break;
  }
  assert.ok(
    found,
    "The second mDNS instance must discover the published service",
  );
  assert.equal(found.authenticated, false);
  await publisher.close();
  for (
    let attempt = 0;
    attempt < 20 && discovery.snapshot().boards.some((b) => b.name === name);
    attempt++
  )
    await delay(100);
  assert.ok(
    !discovery.snapshot().boards.some((b) => b.name === name),
    "The goodbye announcement must remove the service",
  );
  console.log("mDNS publication, discovery and goodbye passed.");
} finally {
  await publisher.close();
  discovery.close();
}
