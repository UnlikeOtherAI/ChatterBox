import type { Message, Session, Method } from "../types.js";
type Page = { messages: Message[]; cursor: string | null; mode?: string };
declare global {
  interface Window {
    board: {
      read<T>(method: Method, args: unknown): Promise<T>;
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
let history: Message[] = [];
let selectedThread = "";
let currentCursor: string | null = null;
let request = 0;
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
const labels: Record<string, string> = {
  accepted_by_board: "Stored · awaiting delivery",
  stored_on_recipient: "Stored on recipient",
  delivery_attempted: "Delivery attempted",
  queued_with_provider: "Queued with provider",
  notification_sent: "Notification sent · awaiting receipt",
  retry_wait: "Retry scheduled",
  acknowledged: "Acknowledged",
};
function empty(title: string, text: string, code?: string) {
  const box = node("div", "", "empty");
  box.append(
    node("div", "↗", "empty-symbol"),
    node("h2", title),
    node("p", text),
  );
  if (code) box.append(node("code", code));
  return box;
}
function setConnection(online: boolean) {
  el("connection-state").textContent = online
    ? "Board connected"
    : "Board unavailable";
  el("connection-dot").classList.toggle("online", online);
}
function showError(error: unknown) {
  el("error").hidden = false;
  el("error").textContent =
    `${error instanceof Error ? error.message : "Could not read the board"}. Your stored messages are preserved. Use Refresh to try again.`;
  setConnection(false);
}
function kv(list: HTMLElement, key: string, value: string) {
  list.append(node("dt", key), node("dd", value));
}
function renderStats() {
  const stats = el("stats");
  stats.replaceChildren();
  const connected = sessions.filter((s) => s.connection === "online").length;
  const pending = history
    .flatMap((m) => m.deliveries ?? [])
    .filter((d) => !d.acknowledgement).length;
  for (const [label, value, note] of [
    ["Registered sessions", String(sessions.length), `${connected} connected`],
    ["Messages loaded", String(history.length), "durable history"],
    ["Awaiting acknowledgement", String(pending), "in loaded messages"],
  ]) {
    const s = node("div", "", "stat");
    const metric = node("div");
    metric.append(
      node("span", value, "stat-number"),
      node("span", note, "stat-note"),
    );
    s.append(node("div", label, "stat-label"), metric);
    stats.append(s);
  }
  el("session-count").textContent = String(sessions.length);
  el("nav-count").textContent = String(history.length);
}
function renderThreads() {
  const threads = [
    ...new Set([...history, ...messages].map((m) => m.thread_id)),
  ];
  el("threads").replaceChildren();
  for (const thread of threads) {
    const b = node(
      "button",
      thread,
      `thread-button${selectedThread === thread ? " active" : ""}`,
    );
    b.title = thread;
    b.onclick = () => {
      selectedThread = thread;
      switchView("activity");
      void loadMessages();
    };
    el("threads").append(b);
  }
  if (!threads.length)
    el("threads").append(
      node("p", "Threads appear when agents talk.", "muted"),
    );
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
    node("h2", m.thread_id),
    node("p", m.body, "message-body"),
  );
  const list = node("dl");
  kv(list, "Message ID", m.message_id);
  kv(list, "From", `${m.from_alias} · ${m.from_session_id}`);
  kv(list, "Created", new Date(m.created_at).toLocaleString());
  for (const d of m.deliveries ?? [])
    kv(
      list,
      `To ${d.to_alias}`,
      `${labels[d.state] ?? d.state}${d.acknowledgement ? ` · ${d.acknowledgement}` : ""}\n${d.attempts} transport attempts${d.detail ? `\n${d.detail}` : ""}`,
    );
  kv(list, "Agent-supplied embeddings", String(m.embedding_count ?? 0));
  root.append(list, node("h3", "Audit trail"));
  el<HTMLDialogElement>("detail").showModal();
  try {
    const audit = await window.board.read<{
      events: { type: string; created_at: number; detail: string }[];
      cursor: string | null;
    }>("audit", { message_id: m.message_id, limit: 100 });
    if (!el<HTMLDialogElement>("detail").open) return;
    for (const event of audit.events) {
      const row = node("div", event.type.replaceAll("_", " "), "audit-event");
      row.append(
        node("small", new Date(event.created_at).toLocaleString()),
        node("small", event.detail),
      );
      root.append(row);
    }
    if (audit.cursor)
      root.append(
        node(
          "p",
          "Showing the first 100 audit events. The API supports paging for the full trail.",
          "muted",
        ),
      );
  } catch (error) {
    root.append(
      node("p", error instanceof Error ? error.message : "Audit unavailable"),
    );
  }
}
function renderMessages() {
  const root = el("messages");
  root.replaceChildren();
  const shown = messages.filter(
    (m) => !filterKind() || m.kind === filterKind(),
  );
  el("feed-label").textContent = query()
    ? "SEARCH RESULTS"
    : selectedThread
      ? `THREAD / ${selectedThread}`
      : "PROJECT ACTIVITY";
  el("result-count").textContent =
    `${shown.length} message${shown.length === 1 ? "" : "s"}${currentCursor ? " · more available" : ""}`;
  for (const m of shown) {
    const article = node("article", "", "message");
    article.dataset.messageId = m.message_id;
    const sender = sessions.find(
      (s) => s.agent_session_id === m.from_session_id,
    );
    const avatar = node(
      "div",
      (m.from_alias ?? "AG").slice(0, 2).toUpperCase(),
      `avatar ${sender?.provider === "codex" ? "codex" : ""}`,
    );
    const content = node("div", "", "message-main");
    const heading = node("div", "", "message-heading");
    heading.append(
      node("strong", m.from_alias ?? "Agent"),
      node("span", "→", "arrow"),
      node(
        "span",
        (m.deliveries ?? []).map((d) => d.to_alias).join(", "),
        "recipient",
      ),
      node("span", m.kind, `kind ${m.kind}`),
    );
    const time = node("time", relative(m.created_at), "message-time");
    time.dateTime = new Date(m.created_at).toISOString();
    time.title = new Date(m.created_at).toLocaleString();
    heading.append(time);
    const footer = node("div", "", "message-footer");
    const thread = node("button", `# ${m.thread_id}`, "thread-link");
    thread.onclick = () => {
      selectedThread = m.thread_id;
      void loadMessages();
    };
    footer.append(thread);
    const deliveries = m.deliveries ?? [];
    const acknowledged = deliveries.filter((d) => d.acknowledgement).length;
    const delivery =
      deliveries.length === 1
        ? (deliveries[0]!.acknowledgement ??
          labels[deliveries[0]!.state] ??
          deliveries[0]!.state)
        : `${acknowledged}/${deliveries.length} acknowledged`;
    footer.append(
      node(
        "span",
        `${acknowledged ? "✓" : "◷"} ${delivery}`,
        `delivery-label${acknowledged ? "" : " pending"}`,
      ),
    );
    if (m.commit_sha)
      footer.append(node("span", m.commit_sha.slice(0, 8), "metadata"));
    if (m.embedding_count)
      footer.append(node("span", "◇ Embedding", "metadata"));
    const more = node("button", "View details ↗", "details-button");
    more.onclick = () => {
      void details(m);
    };
    footer.append(more);
    content.append(heading, node("p", m.body, "message-body"), footer);
    article.append(avatar, content);
    root.append(article);
  }
  if (!shown.length)
    root.append(
      query() || selectedThread || filterKind()
        ? empty(
            "No matching messages",
            "Try another search, message type, or thread. Search matches words and word prefixes.",
          )
        : empty(
            "A quiet board. Ready for company.",
            "Connect your existing Codex or Claude Code sessions. Their coordination messages will appear here as they work.",
            "chatterbox mcp --provider codex --alias mac-dev\n  --native-session YOUR_SESSION_ID --transport codex-queue",
          ),
    );
  el("load-more").hidden = !currentCursor;
  renderThreads();
}
async function loadMessages(more = false) {
  const generation = ++request;
  const args = {
    limit: 50,
    ...(filterKind() ? { kind: filterKind() } : {}),
    ...(selectedThread ? { thread_id: selectedThread } : {}),
    ...(more && currentCursor ? { cursor: currentCursor } : {}),
  };
  try {
    const page = query()
      ? await window.board.read<Page>("search", {
          ...args,
          query: query(),
          ...(filterKind() ? { kind: filterKind() } : {}),
        })
      : await window.board.read<Page>("messages", args);
    if (generation !== request) return;
    messages = more ? [...messages, ...page.messages] : page.messages;
    currentCursor = page.cursor;
    // Chronological API pages are retained in order; search pages retain relevance order.
    if (!query() && !selectedThread) history = messages;
    el("error").hidden = true;
    setConnection(true);
    renderMessages();
    renderStats();
  } catch (error) {
    if (generation === request) showError(error);
  }
}
async function refresh() {
  try {
    const result = await window.board.read<{ sessions: Session[] }>(
      "sessions",
      { limit: 100 },
    );
    sessions = result.sessions;
    renderSessions();
    renderStats();
    await loadMessages();
  } catch (error) {
    showError(error);
  }
}
function switchView(view: string) {
  el("board-panel").hidden = view !== "activity";
  el("sessions-panel").hidden = view !== "sessions";
  el("activity-tab").classList.toggle("active", view === "activity");
  el("sessions-tab").classList.toggle("active", view === "sessions");
  el("activity-tab").setAttribute(
    "aria-current",
    view === "activity" ? "page" : "false",
  );
  el("sessions-tab").setAttribute(
    "aria-current",
    view === "sessions" ? "page" : "false",
  );
  el("page-title").replaceChildren(
    node("span", view === "activity" ? "Message board." : "Sessions."),
  );
  el("page-description").textContent =
    view === "activity"
      ? "One place for the conversations between your coding sessions."
      : "Registered identities, connection evidence, and delivery capabilities.";
}
el("activity-tab").onclick = () => switchView("activity");
el("sessions-tab").onclick = () => switchView("sessions");
el("refresh").onclick = () => {
  void refresh();
};
el("all-threads").onclick = () => {
  selectedThread = "";
  switchView("activity");
  void loadMessages();
};
el("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    void loadMessages();
  }, 180);
});
el("kind").addEventListener("change", () => {
  void loadMessages();
});
el("load-more").onclick = () => {
  void loadMessages(true);
};
el("close-detail").onclick = () => el<HTMLDialogElement>("detail").close();
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !(event.target instanceof HTMLInputElement)) {
    event.preventDefault();
    switchView("activity");
    el("search").focus();
  }
});
async function init() {
  try {
    const ctx = await window.board.context();
    el("project").textContent = ctx.project;
    el("workspace").textContent = ctx.workspace;
    el("breadcrumb-project").textContent = ctx.project;
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
