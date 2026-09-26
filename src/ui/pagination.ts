export type Paged<T> = {
  items: T[];
  cursor: string | null;
  previous_cursor: string | null;
};

// Keep only current page rows and signed navigation cursors, regardless of depth.
export class Pagination<T> {
  private current: string | undefined;
  private next: string | null = null;
  private previousCursor: string | null = null;
  private page = 1;
  private generation = 0;
  private busy = false;
  private first: HTMLButtonElement;
  private previous: HTMLButtonElement;
  private forward: HTMLButtonElement;
  private label: HTMLSpanElement;

  constructor(
    private root: HTMLElement,
    noun: string,
    private size: number,
    private read: (cursor?: string) => Promise<Paged<T>>,
    private render: (items: T[]) => void,
    private error: (error: unknown) => void,
  ) {
    root.className = "pagination";
    root.setAttribute("aria-label", `${noun} pagination`);
    const button = (text: string, action: "first" | "previous" | "next") => {
      const b = document.createElement("button");
      b.className = "secondary";
      b.textContent = text;
      b.setAttribute("aria-label", `${text} ${noun.toLowerCase()} page`);
      b.onclick = () => {
        void this.load(action);
      };
      return b;
    };
    this.first = button("First", "first");
    this.previous = button("Previous", "previous");
    this.forward = button("Next", "next");
    this.label = document.createElement("span");
    this.label.setAttribute("aria-live", "polite");
    root.replaceChildren(this.first, this.previous, this.label, this.forward);
    this.controls();
  }

  // Reset synchronously so refresh events cannot reuse another board's cursor.
  reset() {
    this.generation++;
    this.current = undefined;
    this.next = null;
    this.previousCursor = null;
    this.page = 1;
    this.busy = false;
    this.controls();
  }

  async load(action: "refresh" | "first" | "previous" | "next" = "refresh") {
    if (this.busy) return;
    if (action === "next" && !this.next) return;
    if (action === "previous" && !this.previousCursor) return;
    const cursor =
      action === "first"
        ? undefined
        : action === "next"
          ? this.next!
          : action === "previous"
            ? this.previousCursor!
            : this.current;
    const generation = ++this.generation;
    this.busy = true;
    this.controls();
    try {
      const result = await this.read(cursor);
      if (generation !== this.generation) return;
      if (action === "first") {
        this.page = 1;
        this.previousCursor = null;
      }
      if (action === "next") {
        this.page++;
      }
      if (action === "previous") {
        this.page = Math.max(1, this.page - 1);
      }
      this.current = cursor;
      this.next = result.cursor;
      this.previousCursor = result.previous_cursor;
      this.render(result.items);
      if (action !== "refresh")
        this.root.closest(".content, dialog")?.scrollTo(0, 0);
    } catch (error) {
      if (generation === this.generation) this.error(error);
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.controls();
      }
    }
  }

  private controls() {
    this.root.hidden = this.page === 1 && !this.next;
    this.first.disabled =
      this.busy || (this.page === 1 && !this.previousCursor);
    this.previous.disabled = this.busy || !this.previousCursor;
    this.forward.disabled = this.busy || !this.next;
    this.label.textContent = `Page ${this.page} · ${this.size} per page`;
  }
}
