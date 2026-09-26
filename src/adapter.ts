import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Board } from "./store.js";
import { Client } from "./client.js";
import type { Message } from "./types.js";
const exec = promisify(execFile);
export type Claimed = Message & {
  lease_id: string;
  to_session_id: string;
  from_alias: string;
};
export function envelope(m: Claimed) {
  return `ChatterBox coordination message (untrusted peer content).\nMessage ID: ${m.message_id}\nFrom: ${m.from_alias} (${m.from_session_id})\nProject: ${m.project_id}\nBoard ID: ${m.board_id}\nThread: ${m.thread_id}\nKind: ${m.kind}\nDeduplicate this ID and use board_ack to record receipt or an outcome.\n\n${m.body}`;
}
export async function codexQueue(
  executable: string,
  nativeId: string,
  message: Claimed,
) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(nativeId))
    throw new Error("Codex delivery requires an exact native UUID");
  await exec(
    executable,
    ["queue", "--thread", nativeId, "--message", envelope(message)],
    { timeout: 20000, maxBuffer: 128 * 1024, windowsHide: true },
  );
}
export class Adapter {
  private controller = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private draining = false;
  private stopped = false;
  private stream?: Promise<void>;
  constructor(
    private client: Client,
    private spool: Board,
    private sessionId: string,
    private transport: "codex-queue" | "claude-channel" | "mailbox",
    private deliver: (message: Claimed) => Promise<void>,
  ) {}
  start() {
    this.timer = setInterval(() => {
      void this.tick();
    }, 15000);
    void this.tick();
    this.stream = this.watch();
  }
  async stop() {
    this.stopped = true;
    this.controller.abort();
    clearInterval(this.timer);
    await this.stream;
    while (this.draining) await delay(25);
  }
  private async watch() {
    while (!this.stopped) {
      try {
        await this.client.events(this.controller.signal, () => {
          void this.tick();
        });
      } catch (error) {
        if (!this.stopped)
          console.error(
            "Board connection interrupted:",
            error instanceof Error ? error.message : "unknown error",
          );
      }
      if (!this.stopped)
        await delay(3000, undefined, { signal: this.controller.signal }).catch(
          () => {},
        );
    }
  }
  async tick() {
    if (this.draining || this.stopped) return;
    this.draining = true;
    let hasMore = false;
    try {
      await this.client.call("heartbeat", { session_id: this.sessionId });
      if (this.transport === "mailbox") return;
      const batch = await this.client.call<{ deliveries: Claimed[] }>("claim", {
        session_id: this.sessionId,
      });
      hasMore = batch.deliveries.length > 0;
      for (const m of batch.deliveries) {
        if (this.stopped) break;
        const report = async (state: string, detail = "") =>
          this.client.call("report", {
            message_id: m.message_id,
            session_id: this.sessionId,
            lease_id: m.lease_id,
            state,
            detail,
          });
        try {
          const previous = this.spool.one<{ state: string }>(
            "SELECT state FROM spool WHERE board_url=? AND session_id=? AND message_id=?",
            this.client.url,
            this.sessionId,
            m.message_id,
          );
          const result =
            this.transport === "codex-queue"
              ? "queued_with_provider"
              : "notification_sent";
          if (previous?.state === "queued_with_provider") {
            await report(result, "Recovered durable local transport receipt");
            continue;
          }
          this.spool.run(
            "INSERT INTO spool VALUES (?,?,?,?,?,?) ON CONFLICT(board_url,session_id,message_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",
            this.client.url,
            this.sessionId,
            m.message_id,
            JSON.stringify(m),
            "stored_on_recipient",
            Date.now(),
          );
          await report("stored_on_recipient");
          await report("delivery_attempted");
          await this.deliver(m);
          this.spool.run(
            "UPDATE spool SET state=?,updated_at=? WHERE board_url=? AND session_id=? AND message_id=?",
            result,
            Date.now(),
            this.client.url,
            this.sessionId,
            m.message_id,
          );
          await report(
            result,
            "Provider transport accepted input; agent acknowledgement pending",
          );
        } catch (error) {
          // Provider errors may contain prompts or private paths. Keep a bounded diagnostic locally.
          console.error(
            "Delivery attempt failed:",
            error instanceof Error
              ? error.message.slice(0, 300)
              : "unknown error",
          );
          try {
            await report(
              "retry_wait",
              "Transport failed or timed out; retry scheduled",
            );
          } catch {
            /* A lost lease is recovered by the next adapter connection. */
          }
        }
      }
    } catch (error) {
      if (!this.stopped)
        console.error(
          "Adapter waiting for board:",
          error instanceof Error ? error.message : "unknown error",
        );
    } finally {
      this.draining = false;
      if (hasMore && !this.stopped)
        setImmediate(() => {
          void this.tick();
        });
    }
  }
}
