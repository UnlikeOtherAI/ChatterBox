import { Bonjour, type Service } from "bonjour-service";
import { hostname } from "node:os";
import { isIP } from "node:net";

export const SERVICE_TYPE = "chatterbox";
export type DiscoveredBoard = {
  name: string;
  host: string;
  port: number;
  url: string;
  addresses: string[];
  version: string;
  protocol: string;
  authenticated: false;
};
// Advertisements are untrusted address hints. They never confer membership or identity.
export function describeService(
  service: Pick<Service, "name" | "host" | "port" | "txt" | "addresses">,
): DiscoveredBoard | null {
  const txt: unknown = service.txt;
  if (!txt || typeof txt !== "object") return null;
  const fields = txt as Record<string, unknown>;
  const host = service.host?.replace(/\.$/, "");
  if (
    fields.protocol !== "1" ||
    fields.tls !== "1" ||
    typeof host !== "string" ||
    host.length > 253 ||
    !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host) ||
    host.includes("..") ||
    !Number.isInteger(service.port) ||
    service.port < 1 ||
    service.port > 65535
  )
    return null;
  return {
    name: String(service.name).slice(0, 100),
    host,
    port: service.port,
    url: `https://${host}:${service.port}`,
    addresses: (service.addresses ?? [])
      .filter((a) => isIP(a) !== 0)
      .slice(0, 16),
    version:
      typeof fields.version === "string"
        ? fields.version.slice(0, 40)
        : "unknown",
    protocol: "1",
    authenticated: false,
  };
}
export class Discovery {
  private bonjour: Bonjour;
  private browser: ReturnType<Bonjour["find"]>;
  private timer: ReturnType<typeof setInterval>;
  error: string | null = null;
  constructor(private changed: () => void = () => {}) {
    this.bonjour = new Bonjour({}, () => {
      this.error = "Local network discovery is unavailable on this interface.";
      this.changed();
    });
    this.browser = this.bonjour.find({ type: SERVICE_TYPE, protocol: "tcp" });
    for (const event of ["up", "down", "txt-update", "srv-update"] as const)
      this.browser.on(event, () => this.changed());
    this.timer = setInterval(() => {
      this.browser.expire();
      this.browser.update();
      this.changed();
    }, 30000);
    this.timer.unref();
  }
  snapshot() {
    this.browser.expire();
    return {
      boards: this.browser.services
        .map(describeService)
        .filter((s): s is DiscoveredBoard => s !== null)
        .slice(0, 100),
      error: this.error,
    };
  }
  close() {
    clearInterval(this.timer);
    this.browser.stop();
    this.bonjour.destroy();
  }
}
export function advertise(
  port: number,
  options: { name?: string; host?: string } = {},
) {
  const name = options.name ?? `ChatterBox on ${hostname().slice(0, 40)}`;
  const host = options.host ?? `${hostname().replace(/\.local\.?$/, "")}.local`;
  if (
    Buffer.byteLength(name, "utf8") > 63 ||
    !name.trim() ||
    !describeService({ name, host, port, txt: { protocol: "1", tls: "1" } })
  )
    throw new Error("Invalid mDNS service name, host, or port");
  const bonjour = new Bonjour({}, () =>
    console.error(
      "mDNS advertisement unavailable; the configured board URL still works.",
    ),
  );
  const service = bonjour.publish({
    name,
    host,
    type: SERVICE_TYPE,
    protocol: "tcp",
    port,
    txt: { protocol: "1", version: "0.1.0", tls: "1" },
  });
  service.on("error", () =>
    console.error(
      "mDNS service publication failed; check the service name and network interface.",
    ),
  );
  let closing: Promise<void> | undefined;
  return {
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          bonjour.destroy();
          resolve();
        };
        const timer = setTimeout(finish, 1500);
        bonjour.unpublishAll(finish);
      })),
  };
}
