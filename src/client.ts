import { checkUrl } from "./config.js";
import { BoardError, type Method } from "./types.js";
export class Client {
  url: string;
  constructor(
    url: string,
    public token: string,
  ) {
    this.url = checkUrl(url);
  }
  async call<T = unknown>(method: Method, args: unknown): Promise<T> {
    const response = await fetch(`${this.url}/api/${method}`, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(15000),
    });
    const data = (await response.json()) as {
      error?: string;
      details?: unknown;
    };
    if (!response.ok)
      throw new BoardError(
        response.status,
        data.error ?? `Board returned ${response.status}`,
        data.details,
      );
    return data as T;
  }
  async events(signal: AbortSignal, onChange: () => void) {
    const response = await fetch(`${this.url}/events`, {
      headers: { authorization: `Bearer ${this.token}` },
      redirect: "error",
      signal,
    });
    if (!response.ok || !response.body)
      throw new Error(`Event stream returned ${response.status}`);
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>)
      if (new TextDecoder().decode(chunk).includes("data:")) onChange();
  }
}
