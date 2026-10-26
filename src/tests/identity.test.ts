import { test } from "node:test";
import assert from "node:assert/strict";
import { ancestralClaudeIdentity } from "../identity.js";

const one = "2afd083d-c520-42d9-9bf7-1e35f581f39a";
const two = "1d851686-fec5-4480-8e35-942031eaa9f2";

test("Claude identity matches the nearest owning ancestor PID, never another active session", () => {
  const chain = [
    { pid: 10, executable: "shim" },
    { pid: 20, executable: "claude" },
    { pid: 30, executable: "parent-claude" },
  ];
  assert.equal(
    ancestralClaudeIdentity(chain, [{ pid: 999, sessionId: one }]),
    undefined,
  );
  assert.equal(
    ancestralClaudeIdentity(chain, [
      { pid: 30, sessionId: two },
      { pid: 20, sessionId: one },
    ]),
    one,
  );
  assert.equal(
    ancestralClaudeIdentity(chain, [{ pid: 20, sessionId: "title-or-path" }]),
    undefined,
  );
  assert.throws(
    () =>
      ancestralClaudeIdentity(chain, [
        { pid: 20, sessionId: one },
        { pid: 20, sessionId: two },
      ]),
    /ambiguous/,
  );
});
