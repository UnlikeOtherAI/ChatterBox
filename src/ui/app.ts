import type { DiscoveredBoard } from "../discovery.js";
import type { Message, Session, Method, MessageBoard } from "../types.js";
import { Pagination } from "./pagination.js";
type Page = {
  messages: Message[];
  cursor: string | null;
  previous_cursor: string | null;
  mode?: string;
};
declare global {
  interface Window {
    board: {
      read<T>(method: Method, args: unknown): Promise<T>;
      discover(): Promise<{ boards: DiscoveredBoard[]; error: string | null }>;
      context(): Promise<{
        project: string;
        workspace: string;
        version: string;
      }>;
      onChanged(callback: () => void): () => void;
    };
  }
}
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  cls = "",
) {
  const n = document.createElement(tag);
  n.textContent = text;
  n.className = cls;
  return n;
}
let sessions: Session[] = [];
let messages: Message[] = [];
let activeBoard: MessageBoard | null = null;
let currentView = "boards";

let boardSearchTimer: ReturnType<typeof setTimeout>;
let searchTimer: ReturnType<typeof setTimeout>;
const query = () => el<HTMLInputElement>("search").value.trim();
const filterKind = () => el<HTMLSelectElement>("kind").value;
const relative = (time: number) => {
  const mins = Math.max(0, Math.floor((Date.now() - time) / 60000));
  return mins < 1
    ? "just now"
    : mins < 60
      ? `${mins}m ago`
      : mins < 1440
        ? `${Math.floor(mins / 60)}h ago`
        : new Date(time).toLocaleDateString();
};
function empty(title: string, text: string, code?: string) {
  const box = node("div", "", "empty");
  box.append(node("h2", title), node("p", text));
  if (code) box.append(node("code", code));
  return box;
}
function setConnection(online: boolean) {
  el("connection-state").textContent = online ? "Connected" : "Disconnected";
  el("connection-dot").classList.toggle("online", online);
}
function showError(error: unknown) {
  el("error").hidden = false;
  el("error").textContent =
    `${error instanceof Error ? error.message : "Could not load messages"}. Use Refresh to try again.`;
  setConnection(false);
}
function kv(list: HTMLElement, key: string, value: string) {
  list.append(node("dt", key), node("dd", value));
}
function renderSessions() {
  const root = el("sessions");
  root.replaceChildren();
  for (const s of sessions) {
    const card = node("article", "", "session-card");
    card.append(
      node("h2", s.alias),
      node("p", `${s.provider} · ${s.os} · ${s.runtime_id}`),
    );
    const list = node("dl");
    kv(
      list,
      "Adapter connection",
      `${s.connection} · last seen ${relative(s.last_seen)}`,
    );
    kv(
      list,
      "Agent-reported state",
      s.state === "unknown"
        ? "Unknown / stale"
        : `${s.state} · ${relative(s.state_at)}`,
    );
    kv(list, "Native working state", "Unknown — no lifecycle signal");
    kv(list, "Delivery capability", s.capability);
    if (s.task) kv(list, "Task", s.task);
    if (s.revision) kv(list, "Revision", s.revision);
    kv(list, "Machine identity", s.machine_id);
    kv(list, "Native session", s.native_session_id);
    kv(list, "Provider version", s.provider_version);
    card.append(list);
    root.append(card);
  }
  if (!sessions.length)
    root.append(
      empty(
        "No sessions registered",
        "Connect an existing coding session with the ChatterBox MCP server to make it visible here.",
      ),
    );
}
async function details(m: Message) {
  const root = el("detail-content");
  root.replaceChildren(
    node("h2", m.from_alias ?? "Agent"),
    node("p", new Date(m.created_at).toLocaleString(), "message-date"),
    node("p", m.body, "message-body"),
  );
  const more = node("details", "", "message-metadata");
  more.append(node("summary", "Details"));
  const list = node("dl");
  kv(list, "Board", activeBoard?.name ?? m.board_id);
  kv(list, "Thread", m.thread_id);
  kv(list, "Message ID", m.message_id);
  for (const d of m.deliveries ?? [])
    kv(
      list,
      `To ${d.to_alias}`,
      d.acknowledgement ?? d.state.replaceAll("_", " "),
    );
  if (m.embedding_count) kv(list, "Embeddings", String(m.embedding_count));
  more.append(list, node("h3", "History"));
  root.append(more);
  el<HTMLDialogElement>("detail").showModal();
  const events = node("div");
  const controls = node("nav");
  more.append(events, controls);
  const pager = new Pagination<{
    type: string;
    created_at: number;
    detail: string;
  }>(
    controls,
    "Audit",
    50,
    async (cursor) => {
      const result = await window.board.read<{
        events: { type: string; created_at: number; detail: string }[];
        cursor: string | null;
        previous_cursor: string | null;
      }>("audit", {
        message_id: m.message_id,
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      return {
        items: result.events,
        cursor: result.cursor,
        previous_cursor: result.previous_cursor,
      };
    },
    (items) => {
      events.replaceChildren();
      for (const event of items) {
        const row = node("div", event.type.replaceAll("_", " "), "audit-event");
        row.append(
          node("small", new Date(event.created_at).toLocaleString()),
          node("small", event.detail),
        );
        events.append(row);
      }
    },
    (error) =>
      events.replaceChildren(
        node("p", error instanceof Error ? error.message : "Audit unavailable"),
      ),
  );
  await pager.load();
}
function renderMessages() {
  const root = el("messages");
  root.replaceChildren();
  for (const m of messages) {
    const row = node("button", "", "message");
    row.type = "button";
    row.dataset.messageId = m.message_id;
    row.setAttribute("aria-label", `Message from ${m.from_alias ?? "Agent"}`);
    const body = node("span", "", "message-main");
    const heading = node("span", "", "message-heading");
    const time = node("time", relative(m.created_at), "message-time");
    time.dateTime = new Date(m.created_at).toISOString();
    time.title = new Date(m.created_at).toLocaleString();
    heading.append(node("strong", m.from_alias ?? "Agent"), time);
    body.append(heading, node("span", m.body, "message-preview"));
    row.append(body);
    row.onclick = () => {
      void details(m);
    };
    root.append(row);
  }
  if (!messages.length)
    root.append(
      empty(
        query() || filterKind() ? "No matching messages" : "No messages yet",
        query() || filterKind()
          ? "Try a different search or type."
          : "Messages from connected agents will appear here.",
      ),
    );
}
const messagesPager = new Pagination<Message>(
  el("messages-pagination"),
  "Messages",
  50,
  async (cursor) => {
    if (!activeBoard) return { items: [], cursor: null, previous_cursor: null };
    const args = {
      limit: 50,
      board_id: activeBoard.board_id,
      ...(filterKind() ? { kind: filterKind() } : {}),
      ...(cursor ? { cursor } : {}),
    };
    const result = query()
      ? await window.board.read<Page>("search", {
          ...args,
          query: query(),
          sort: "newest",
        })
      : await window.board.read<Page>("messages", args);
    return {
      items: result.messages,
      cursor: result.cursor,
      previous_cursor: result.previous_cursor,
    };
  },
  (items) => {
    messages = items;
    el("error").hidden = true;
    setConnection(true);
    renderMessages();
  },
  showError,
);
function resetMessages() {
  messagesPager.reset();
  messages = [];
  renderMessages();
  void messagesPager.load();
}
const sessionsPager = new Pagination<Session>(
  el("sessions-pagination"),
  "Sessions",
  20,
  async (cursor) => {
    const result = await window.board.read<{
      sessions: Session[];
      cursor: string | null;
      previous_cursor: string | null;
    }>("sessions", { limit: 20, ...(cursor ? { cursor } : {}) });
    return {
      items: result.sessions,
      cursor: result.cursor,
      previous_cursor: result.previous_cursor,
    };
  },
  (items) => {
    sessions = items;
    renderSessions();
  },
  showError,
);
const boardsPager = new Pagination<MessageBoard>(
  el("boards-pagination"),
  "Boards",
  20,
  async (cursor) => {
    const result = await window.board.read<{
      boards: MessageBoard[];
      cursor: string | null;
      previous_cursor: string | null;
    }>("boards", {
      limit: 20,
      query: el<HTMLInputElement>("board-search").value.trim(),
      ...(cursor ? { cursor } : {}),
    });
    return {
      items: result.boards,
      cursor: result.cursor,
      previous_cursor: result.previous_cursor,
    };
  },
  (items) => {
    el("boards").replaceChildren();
    for (const board of items) {
      const row = node("button", "", "board-row");
      row.type = "button";
      row.title = board.board_id;
      row.setAttribute("aria-label", `Open ${board.name}`);
      const content = node("span", "", "board-row-content");
      content.append(node("strong", board.name));
      if (board.description)
        content.append(node("span", board.description, "board-description"));
      row.append(content);
      if (board.created_at) {
        const time = node("time", relative(board.created_at), "board-time");
        time.dateTime = new Date(board.created_at).toISOString();
        time.title = new Date(board.created_at).toLocaleString();
        row.append(time);
      }
      row.onclick = () => {
        activeBoard = board;
        el<HTMLInputElement>("search").value = "";
        el<HTMLSelectElement>("kind").value = "";
        switchView("activity");
        resetMessages();
      };
      el("boards").append(row);
    }
    if (!items.length)
      el("boards").append(
        empty("No matching boards", "Try a different search."),
      );
    el("error").hidden = true;
    setConnection(true);
  },
  showError,
);
const networkPager = new Pagination<DiscoveredBoard>(
  el("network-pagination"),
  "Network services",
  20,
  async (cursor) => {
    const result = await window.board.discover();
    const boards = result.boards.sort((a, b) => a.url.localeCompare(b.url));
    const start = Number(cursor ?? 0);
    if (!boards.length && result.error) throw new Error(result.error);
    return {
      items: boards.slice(start, start + 20),
      cursor: boards.length > start + 20 ? String(start + 20) : null,
      previous_cursor: start > 0 ? String(Math.max(0, start - 20)) : null,
    };
  },
  (items) => {
    const root = el("network-boards");
    root.replaceChildren();
    for (const board of items) {
      const card = node("article", "", "session-card");
      card.append(node("h2", board.name), node("p", board.url));
      const list = node("dl");
      kv(list, "Status", "Discovered · credentials required");
      kv(
        list,
        "Protocol",
        `ChatterBox ${board.protocol} · version ${board.version}`,
      );
      kv(list, "Network addresses", board.addresses.join(", ") || board.host);
      card.append(list);
      root.append(card);
    }
    if (!items.length)
      root.append(
        empty(
          "No nearby services found",
          "Only reachable TLS services advertise. Local-only services stay private.",
        ),
      );
  },
  (error) =>
    el("network-boards").replaceChildren(
      empty(
        "Discovery unavailable",
        error instanceof Error
          ? error.message
          : "Check local network permissions.",
      ),
    ),
);
async function refresh() {
  if (currentView === "boards") await boardsPager.load();
  else if (currentView === "sessions") await sessionsPager.load();
  else if (currentView === "network") await networkPager.load();
  else await messagesPager.load();
}
function switchView(view: string) {
  if (view === "activity" && !activeBoard) view = "boards";
  currentView = view;
  el("boards-panel").hidden = view !== "boards";
  el("board-panel").hidden = view !== "activity";
  el("sessions-panel").hidden = view !== "sessions";
  el("network-panel").hidden = view !== "network";
  el("back-boards").hidden = view !== "activity";
  for (const [id, selected] of [
    ["activity-tab", view === "boards" || view === "activity"],
    ["sessions-tab", view === "sessions"],
    ["network-tab", view === "network"],
  ] as const) {
    el(id).classList.toggle("active", selected);
    el(id).setAttribute("aria-current", selected ? "page" : "false");
  }
  el("page-title").textContent =
    view === "boards"
      ? "Message boards"
      : view === "activity"
        ? activeBoard!.name
        : view === "sessions"
          ? "Sessions"
          : "Network";
  el("page-description").textContent =
    view === "activity" ? activeBoard!.description : "";
  el("page-description").hidden =
    view !== "activity" || !activeBoard?.description;
  document.querySelector(".content")?.scrollTo(0, 0);
}
function showBoards() {
  switchView("boards");
  void boardsPager.load();
}
el("activity-tab").onclick = showBoards;
el("back-boards").onclick = showBoards;
el("sessions-tab").onclick = () => {
  switchView("sessions");
  void sessionsPager.load();
};
el("network-tab").onclick = () => {
  switchView("network");
  void networkPager.load();
};
el("refresh").onclick = () => {
  void refresh();
};
el("board-search").addEventListener("input", () => {
  clearTimeout(boardSearchTimer);
  boardSearchTimer = setTimeout(() => {
    boardsPager.reset();
    void boardsPager.load();
  }, 180);
});
el("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    resetMessages();
  }, 180);
});
el("kind").addEventListener("change", () => {
  resetMessages();
});
el("close-detail").onclick = () => el<HTMLDialogElement>("detail").close();
async function init() {
  try {
    switchView("boards");
    await refresh();
    let updateTimer: ReturnType<typeof setTimeout>;
    window.board.onChanged(() => {
      clearTimeout(updateTimer);
      updateTimer = setTimeout(() => {
        void refresh();
      }, 150);
    });
    setInterval(() => {
      void refresh();
    }, 30000);
  } catch (error) {
    showError(error);
  }
}
void init();
