import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Capture = {
  id: string;
  raw_text: string;
  source: string;
  title?: string | null;
  summary?: string | null;
  type: string;
  category?: string | null;
  priority: string;
  due_date?: string | null;
  status: string;
  processing_status: string;
  created_at: string;
  tags?: string[];
  action_items?: ActionItem[];
  calendar_entry?: CalendarEntry | null;
};

type CalendarEntry = {
  id: string;
  capture_id?: string | null;
  title: string;
  description?: string | null;
  location?: string | null;
  start_time: string;
  end_time?: string | null;
  timezone: string;
  all_day: number;
  status: "pending" | "exported" | "created" | "canceled" | "failed";
  source: string;
  external_event_id?: string | null;
  capture_preview?: string | null;
};

type ActionItem = {
  id?: string;
  text: string;
  status?: string;
  due_date?: string | null;
};

type CaptureListResponse = { captures?: Capture[] };
type CaptureResponse = { capture: Capture };
type StatsResponse = { today: number; openTasks: number; unprocessed: number; ideasWeek: number };
type TagSummary = { name: string; count: number };
type TagsResponse = { tags?: TagSummary[] };
type CalendarListResponse = { calendar_entries?: CalendarEntry[] };
type CalendarResponse = { calendar_entry: CalendarEntry };
type GoogleCalendarStatus = { configured: boolean; connected: boolean; scope?: string | null };

const typeOptions = ["note", "task", "idea", "reminder", "question", "project"];
const categoryOptions = ["work"];
const statusOptions = ["inbox", "active", "done", "dismissed", "archived"];
const openStatusOptions = ["inbox", "active"];
const filterOptions = [
  { label: "All", value: "" },
  { label: "Tasks", value: "task" },
  { label: "Ideas", value: "idea" },
  { label: "Reminders", value: "reminder" },
  { label: "Projects", value: "project" },
  { label: "Notes", value: "note" },
  { label: "Questions", value: "question" }
];

function preview(capture: Capture) {
  const text = capture.title || capture.raw_text.split("\n")[0] || capture.raw_text;
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

function summary(capture: Capture) {
  return capture.summary || capture.raw_text;
}

function sourceLabel(source: string) {
  if (source === "api") return "API";
  return source ? source.charAt(0).toUpperCase() + source.slice(1) : "Web";
}

function captureTime(value: string) {
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const day = sameDay ? "Today" : date.toLocaleDateString([], { month: "short", day: "numeric" });
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${day} · ${time}`;
}

function path() {
  return window.location.pathname;
}

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [route, setRoute] = useState(path());

  useEffect(() => {
    fetch("/api/session").then((r) => setAuthed(r.ok));
    const onPop = () => setRoute(path());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function nav(to: string) {
    history.pushState(null, "", to);
    setRoute(to);
  }

  if (authed === null) return <div className="shell">Loading...</div>;
  if (!authed) return <Login onLogin={() => setAuthed(true)} />;

  return (
    <div className="app">
      <aside className="nav">
        <button className="brand" onClick={() => nav("/")}>
          <span className="brand-mark">B</span>
          <span>BrainDump</span>
        </button>
        {["/feed", "/work", "/tasks", "/ideas", "/reminders", "/calendar", "/review", "/chat", "/settings"].map((item) => (
          <button key={item} className={route === item ? "active" : ""} onClick={() => nav(item)}>
            {item.slice(1)}
          </button>
        ))}
      </aside>
      <main className="shell">
        {route === "/" && <Dashboard nav={nav} />}
        {route === "/capture" && <CapturePage />}
        {route === "/feed" && <Feed />}
        {route === "/work" && <Feed fixedCategory="work" title="Work" />}
        {route === "/tasks" && <Feed fixedType="task" title="Tasks" includePendingActions />}
        {route === "/ideas" && <Feed fixedType="idea" title="Ideas" />}
        {route === "/reminders" && <Feed fixedType="reminder" title="Reminders" />}
        {route === "/projects" && <Feed fixedType="project" title="Projects" />}
        {route === "/archive" && <Feed title="Archive" initialStatus="archived" includeClosed />}
        {route === "/review" && <ReviewPage />}
        {route === "/calendar" && <CalendarPage />}
        {route === "/chat" && <ChatBridge />}
        {route.startsWith("/capture/") && <CaptureDetail id={route.split("/")[2]} />}
        {route.startsWith("/calendar/") && <CalendarDetail id={route.split("/")[2]} />}
        {route === "/settings" && <Settings />}
      </main>
    </div>
  );
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    if (res.ok) onLogin();
    else setError("Invalid password");
  }
  return (
    <main className="login">
      <form className="card login-card" onSubmit={submit}>
        <h1>BrainDump</h1>
        <p>Send it now. Sort it later.</p>
        <input type="password" placeholder="App password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <p className="error">{error}</p>}
        <button type="submit">Log in</button>
      </form>
    </main>
  );
}

function QuickCapture({ onSaved }: { onSaved?: () => void }) {
  const [rawText, setRawText] = useState("");
  const [type, setType] = useState("note");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!rawText.trim()) return;
    setSaving(true);
    setError("");
    setToast("");
    try {
      const res = await fetch("/api/captures", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw_text: rawText, source: "web", type_hint: type })
      });
      if (!res.ok) throw new Error("Save failed");
      setRawText("");
      setToast("Captured.");
      onSaved?.();
      window.setTimeout(() => setToast(""), 2200);
    } catch {
      setError("Could not save that capture. Try again.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="card capture-card" onSubmit={submit}>
      <label className="sr-only" htmlFor="quick-capture">Capture text</label>
      <textarea id="quick-capture" autoFocus placeholder="Text yourself anything. Add #tags to sort it." value={rawText} onChange={(e) => setRawText(e.target.value)} />
      <div className="capture-actions">
        <label className="sr-only" htmlFor="capture-type">Capture type</label>
        <select id="capture-type" value={type} onChange={(e) => setType(e.target.value)}>{typeOptions.map((t) => <option key={t}>{t}</option>)}</select>
        <button disabled={saving || !rawText.trim()}>{saving ? "Saving..." : "Capture"}</button>
      </div>
      {error && <p className="error">{error}</p>}
      {toast && <p className="toast">{toast}</p>}
    </form>
  );
}

function Dashboard({ nav }: { nav: (to: string) => void }) {
  const [items, setItems] = useState<Capture[]>([]);
  const [tags, setTags] = useState<TagSummary[]>([]);
  const [stats, setStats] = useState({ today: 0, openTasks: 0, unprocessed: 0, ideasWeek: 0 });
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [tag, setTag] = useState("");
  const query = useMemo(() => {
    const p = new URLSearchParams({ limit: "30", open_only: "1" });
    if (q) p.set("q", q);
    if (type) p.set("type", type);
    if (tag) p.set("tag", tag);
    return p.toString();
  }, [q, type, tag]);
  async function load() {
    const [recent, statsRes, tagsRes] = await Promise.all([fetch(`/api/captures?${query}`), fetch("/api/stats"), fetch("/api/tags")]);
    const recentData = await recent.json() as CaptureListResponse;
    const statsData = await statsRes.json() as StatsResponse;
    const tagsData = await tagsRes.json() as TagsResponse;
    setItems(recentData.captures || []);
    setStats(statsData);
    setTags(tagsData.tags || []);
  }
  useEffect(() => { load(); }, [query]);
  return (
    <div className="mind-grid">
      <section className="main-column">
        <section className="mind-capture">
          <div className="section-head">
            <div>
              <p className="eyebrow">Private feed</p>
              <h1>Everything in your head.</h1>
            </div>
            <button className="ghost" onClick={() => nav("/feed")}>Full feed</button>
          </div>
          <QuickCapture onSaved={load} />
        </section>
        <FeedControls q={q} setQ={setQ} type={type} setType={setType} />
        <TagRail tags={tags} activeTag={tag} setTag={setTag} />
        <div className="section-head">
          <h2>{tag ? `#${tag}` : "Latest"}</h2>
          {(tag || type || q) && <button className="ghost" onClick={() => { setTag(""); setType(""); setQ(""); }}>Clear</button>}
        </div>
        <CaptureList items={items} />
      </section>
      <RightPanel stats={stats} tags={tags} setTag={setTag} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="card stat"><strong>{value}</strong><span>{label}</span></div>;
}

function CapturePage() {
  return <section className="hero compact"><p className="eyebrow">Quick capture</p><h1>Send it now. Sort it later.</h1><QuickCapture /><StatusPills /></section>;
}

function Feed({
  fixedType,
  title = "Feed",
  processingStatus,
  includePendingActions,
  fixedCategory,
  fixedTag,
  initialStatus = "",
  includeClosed = false
}: {
  fixedType?: string;
  title?: string;
  processingStatus?: string;
  includePendingActions?: boolean;
  fixedCategory?: string;
  fixedTag?: string;
  initialStatus?: string;
  includeClosed?: boolean;
}) {
  const [items, setItems] = useState<Capture[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const [source, setSource] = useState("");
  const [type, setType] = useState(fixedType || "");
  const query = useMemo(() => {
    const p = new URLSearchParams({ limit: "50" });
    if (q) p.set("q", q);
    if (status) p.set("status", status);
    else if (!includeClosed) p.set("open_only", "1");
    if (source) p.set("source", source);
    if (type) p.set("type", type);
    if (fixedCategory) p.set("category", fixedCategory);
    if (fixedTag) p.set("tag", fixedTag);
    if (processingStatus) p.set("processing_status", processingStatus);
    if (includePendingActions) p.set("pending_actions", "1");
    return p.toString();
  }, [q, status, source, type, fixedCategory, fixedTag, processingStatus, includePendingActions, includeClosed]);
  useEffect(() => { fetch(`/api/captures?${query}`).then((r) => r.json() as Promise<CaptureListResponse>).then((d) => setItems(d.captures || [])); }, [query]);
  return (
    <section className="main-column feed-page">
      <header className="topline"><div><p className="eyebrow">BrainDump</p><h1>{title}</h1></div></header>
      <FeedControls q={q} setQ={setQ} type={type} setType={setType} fixedType={fixedType} />
      <div className="card filters">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{includeClosed ? "Any status" : "Open statuses"}</option>
          {(includeClosed ? statusOptions : openStatusOptions).map((s) => <option key={s}>{s}</option>)}
          {!includeClosed && <option value="done">done</option>}
          {!includeClosed && <option value="dismissed">dismissed</option>}
          {!includeClosed && <option value="archived">archived</option>}
        </select>
        <input placeholder="Source" value={source} onChange={(e) => setSource(e.target.value)} />
      </div>
      <CaptureList items={items} />
    </section>
  );
}

function ReviewPage() {
  return (
    <section className="main-column feed-page">
      <section className="card review-note">
        <p className="eyebrow">Review</p>
        <h1>AI is currently off.</h1>
        <p>Captures are still saved instantly. When an AI provider is configured, this view can help review processed, failed, and unprocessed items.</p>
      </section>
      <Feed processingStatus="unprocessed" title="Unprocessed captures" />
    </section>
  );
}

function CaptureList({ items }: { items: Capture[] }) {
  if (!items.length) return <div className="empty">Nothing dumped yet. Send a thought from Telegram or type one above.</div>;
  return <section className="list">{items.map((item) => <CaptureRow key={item.id} item={item} />)}</section>;
}

function CaptureRow({ item }: { item: Capture }) {
  const tags = item.tags?.length ? item.tags : [item.category].filter(Boolean) as string[];
  const categoryClass = item.category ? ` category-${item.category.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}` : "";
  return (
    <a className={`card row type-${item.type}${categoryClass}`} href={`/capture/${item.id}`} onClick={(e) => { e.preventDefault(); history.pushState(null, "", `/capture/${item.id}`); dispatchEvent(new PopStateEvent("popstate")); }}>
      <div className="row-top">
        {item.category && <span className={`type-badge category ${item.category.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`}>#{item.category}</span>}
        <span className={`type-badge ${item.type}`}>{item.type}</span>
        {item.status !== "inbox" && <span className={`status-badge ${item.status}`}>{item.status}</span>}
      </div>
      <h2>{preview(item)}</h2>
      <p>{summary(item)}</p>
      <div className="meta">{captureTime(item.created_at)} · {sourceLabel(item.source)}</div>
      <div className="badges">
        <span>{sourceLabel(item.source)}</span>
        {tags.map((b) => <span key={b}>#{b}</span>)}
        <span className={`processing ${item.processing_status}`}>{item.processing_status === "unprocessed" ? "AI off" : item.processing_status}</span>
      </div>
    </a>
  );
}

function FeedControls({ q, setQ, type, setType, fixedType }: { q: string; setQ: (q: string) => void; type: string; setType: (type: string) => void; fixedType?: string }) {
  return (
    <section className="feed-controls">
      <label className="sr-only" htmlFor="capture-search">Search captures</label>
      <input id="capture-search" className="search" placeholder="Search everything..." value={q} onChange={(e) => setQ(e.target.value)} />
      {!fixedType && (
        <div className="filter-pills">
          {filterOptions.map((filter) => (
            <button key={filter.label} className={type === filter.value ? "selected" : ""} onClick={() => setType(filter.value)}>{filter.label}</button>
          ))}
        </div>
      )}
    </section>
  );
}

function TagRail({ tags, activeTag, setTag }: { tags: TagSummary[]; activeTag: string; setTag: (tag: string) => void }) {
  if (!tags.length) return <div className="tag-rail empty-tags">Text #work, #idea, or any hashtag to build your tag list.</div>;
  return (
    <div className="tag-rail">
      <button className={!activeTag ? "selected" : ""} onClick={() => setTag("")}>All tags</button>
      {tags.map((tag) => (
        <button key={tag.name} className={activeTag === tag.name ? "selected" : ""} onClick={() => setTag(tag.name)}>
          <span>#{tag.name}</span><em>{tag.count}</em>
        </button>
      ))}
    </div>
  );
}

function StatusPills() {
  return (
    <div className="source-pills">
      <span>Web Ready</span>
      <span>Telegram Connected</span>
      <span>API Ready</span>
      <span className="ai-off">AI Off</span>
    </div>
  );
}

function RightPanel({ stats, tags, setTag }: { stats: StatsResponse; tags: TagSummary[]; setTag: (tag: string) => void }) {
  return (
    <aside className="right-panel">
      <section className="card ready-card">
        <p className="eyebrow">Text interface</p>
        <h2>Send it. Search it. Tag it.</h2>
        <p>Telegram captures, web captures, and API posts all land in the same private feed. Hashtags become filters automatically.</p>
        <StatusPills />
      </section>
      <section className="mini-stats">
        <Stat label="Captures today" value={stats.today} />
        <Stat label="Open tasks" value={stats.openTasks} />
        <Stat label="Ideas this week" value={stats.ideasWeek} />
        <Stat label="Unprocessed" value={stats.unprocessed} />
      </section>
      <section className="card telegram-card">
        <span className="type-badge reminder">Ollama</span>
        <h2>GISD Chat</h2>
        <p>Use your Ollama chat surface alongside BrainDump when a captured thought needs expansion.</p>
        <a className="link-button" href="https://chat.gisd.tech" target="_blank" rel="noreferrer">Open chat.gisd.tech</a>
      </section>
      <section className="card tag-card">
        <p className="eyebrow">Top tags</p>
        {tags.slice(0, 8).map((tag) => <button key={tag.name} onClick={() => setTag(tag.name)}>#{tag.name}<span>{tag.count}</span></button>)}
      </section>
    </aside>
  );
}

function ChatBridge() {
  return (
    <section className="card settings">
      <p className="eyebrow">Ollama chat</p>
      <h1>GISD Chat</h1>
      <p>BrainDump keeps the capture feed. GISD Chat is the connected Ollama surface for expanding, rewriting, or reasoning over what you saved.</p>
      <a className="link-button" href="https://chat.gisd.tech" target="_blank" rel="noreferrer">Open chat.gisd.tech</a>
    </section>
  );
}

function CalendarPage() {
  const [items, setItems] = useState<CalendarEntry[]>([]);
  const [google, setGoogle] = useState<GoogleCalendarStatus>({ configured: false, connected: false });
  const [rawText, setRawText] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  async function load() {
    const [calendarRes, googleRes] = await Promise.all([fetch("/api/calendar"), fetch("/api/calendar/google/status")]);
    const data = await calendarRes.json() as CalendarListResponse;
    setItems(data.calendar_entries || []);
    if (googleRes.ok) setGoogle(await googleRes.json() as GoogleCalendarStatus);
  }
  useEffect(() => {
    load();
    const result = new URLSearchParams(window.location.search).get("google");
    if (result === "connected") {
      setMessage("Google Calendar connected.");
      history.replaceState(null, "", "/calendar");
    } else if (result === "error") {
      setMessage("Google Calendar authorization was not completed.");
      history.replaceState(null, "", "/calendar");
    }
  }, []);
  async function disconnectGoogle() {
    await fetch("/api/calendar/google/disconnect", { method: "POST" });
    setMessage("Google Calendar disconnected.");
    load();
  }
  async function create(e: FormEvent) {
    e.preventDefault();
    if (!rawText.trim()) return;
    setSaving(true);
    setMessage("");
    const captureRes = await fetch("/api/captures", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw_text: rawText, source: "web", type_hint: "reminder" })
    });
    if (!captureRes.ok) {
      setMessage("Could not save the capture.");
      setSaving(false);
      return;
    }
    const captureData = await captureRes.json() as CaptureResponse;
    const calendarRes = await fetch(`/api/calendar/from-capture/${captureData.capture.id}`, { method: "POST" });
    if (calendarRes.ok) {
      setRawText("");
      setMessage("Calendar candidate saved.");
      await load();
    } else {
      setMessage("Capture saved, but no clear date/time was found. Try: tomorrow 9am call vendor.");
    }
    setSaving(false);
  }
  const pending = items.filter((item) => item.status === "pending");
  const completed = items.filter((item) => item.status === "exported" || item.status === "created");
  const failed = items.filter((item) => item.status === "failed" || item.status === "canceled");
  return (
    <section className="main-column calendar-page">
      <header className="topline"><div><p className="eyebrow">Calendar candidates</p><h1>Calendar</h1></div></header>
      <section className="card google-calendar-status">
        <div>
          <p className="eyebrow">Google Calendar</p>
          <h2>{google.connected ? "Connected" : google.configured ? "Ready to connect" : "Not configured"}</h2>
          <p>{google.connected ? "Candidates can be created directly in your primary Google Calendar." : "Connect once to enable direct event creation. ICS export remains available."}</p>
        </div>
        {google.connected
          ? <button className="muted" onClick={disconnectGoogle}>Disconnect</button>
          : <a className={`link-button${google.configured ? "" : " disabled"}`} href={google.configured ? "/api/calendar/google/connect" : undefined}>Connect Google Calendar</a>}
      </section>
      <form className="card calendar-capture" onSubmit={create}>
        <label htmlFor="calendar-capture">Create from a capture</label>
        <textarea id="calendar-capture" placeholder="tomorrow 9am call website vendor" value={rawText} onChange={(e) => setRawText(e.target.value)} />
        <div className="capture-actions"><button disabled={saving || !rawText.trim()}>{saving ? "Saving..." : "Create candidate"}</button></div>
        {message && <p className={message.startsWith("Calendar") ? "toast" : "helper-text"}>{message}</p>}
      </form>
      <CalendarGroup title="Pending" items={pending} googleConnected={google.connected} onChanged={load} empty="No pending calendar candidates." />
      <CalendarGroup title="Exported / created" items={completed} googleConnected={google.connected} onChanged={load} empty="No exported entries yet." />
      <CalendarGroup title="Failed / canceled" items={failed} googleConnected={google.connected} onChanged={load} empty="No failed entries." />
    </section>
  );
}

function CalendarGroup({ title, items, googleConnected, onChanged, empty }: { title: string; items: CalendarEntry[]; googleConnected: boolean; onChanged: () => void; empty: string }) {
  return (
    <section className="calendar-group">
      <h2>{title}</h2>
      {items.length ? <div className="calendar-list">{items.map((item) => <CalendarCard key={item.id} item={item} googleConnected={googleConnected} onChanged={onChanged} />)}</div> : <div className="empty">{empty}</div>}
    </section>
  );
}

function CalendarCard({ item, googleConnected = false, onChanged }: { item: CalendarEntry; googleConnected?: boolean; onChanged: () => void }) {
  const display = calendarDisplay(item);
  const [creatingGoogle, setCreatingGoogle] = useState(false);
  const [googleError, setGoogleError] = useState("");
  async function markExported() {
    await fetch(`/api/calendar/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "exported" })
    });
    onChanged();
  }
  async function cancel() {
    await fetch(`/api/calendar/${item.id}`, { method: "DELETE" });
    onChanged();
  }
  async function createInGoogle() {
    setCreatingGoogle(true);
    setGoogleError("");
    const response = await fetch(`/api/calendar/${item.id}/google`, { method: "POST" });
    if (response.ok) onChanged();
    else {
      const data = await response.json().catch(() => ({ error: "Google Calendar creation failed" })) as { error?: string };
      setGoogleError(data.error || "Google Calendar creation failed");
    }
    setCreatingGoogle(false);
  }
  return (
    <article id={item.id} className="card calendar-card">
      <div className="row-top">
        <span className={`status-badge calendar-${item.status}`}>{item.status}</span>
        <span className="type-badge reminder">{sourceLabel(item.source)}</span>
      </div>
      <a className="calendar-title" href={`/calendar/${item.id}`}><h3>{item.title}</h3></a>
      <p className="calendar-when">{display.date}<br />{display.time} · {display.duration}</p>
      {item.location && <p>{item.location}</p>}
      {item.capture_preview && <p className="calendar-preview">{item.capture_preview}</p>}
      <div className="calendar-actions">
        {googleConnected && item.status !== "created" && item.status !== "canceled" && <button disabled={creatingGoogle} onClick={createInGoogle}>{creatingGoogle ? "Creating..." : "Create in Google"}</button>}
        {item.external_event_id && <span className="google-created">Google event created</span>}
        <a className="link-button" href={`/api/calendar/${item.id}/ics`}>Download .ics</a>
        {item.status === "pending" && <button onClick={markExported}>Mark done / exported</button>}
        {item.status !== "canceled" && <button className="muted" onClick={cancel}>Cancel</button>}
      </div>
      {googleError && <p className="error">{googleError}</p>}
    </article>
  );
}

function CalendarDetail({ id }: { id: string }) {
  const [entry, setEntry] = useState<CalendarEntry | null>(null);
  const [message, setMessage] = useState("");
  async function load() {
    const res = await fetch(`/api/calendar/${id}`);
    if (res.ok) setEntry((await res.json() as CalendarResponse).calendar_entry);
  }
  useEffect(() => { load(); }, [id]);
  if (!entry) return <div>Loading...</div>;
  async function save() {
    const res = await fetch(`/api/calendar/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry)
    });
    setMessage(res.ok ? "Saved." : "Could not save.");
    if (res.ok) load();
  }
  return (
    <section className="card editor">
      <p className="eyebrow">Calendar entry</p>
      <input placeholder="Title" value={entry.title} onChange={(e) => setEntry({ ...entry, title: e.target.value })} />
      <textarea placeholder="Description" value={entry.description || ""} onChange={(e) => setEntry({ ...entry, description: e.target.value })} />
      <input placeholder="Location" value={entry.location || ""} onChange={(e) => setEntry({ ...entry, location: e.target.value })} />
      <div className="grid calendar-edit-grid">
        <input aria-label="Start time" value={entry.start_time} onChange={(e) => setEntry({ ...entry, start_time: e.target.value })} />
        <input aria-label="End time" value={entry.end_time || ""} onChange={(e) => setEntry({ ...entry, end_time: e.target.value })} />
        <select value={entry.status} onChange={(e) => setEntry({ ...entry, status: e.target.value as CalendarEntry["status"] })}>
          {["pending", "exported", "created", "canceled", "failed"].map((status) => <option key={status}>{status}</option>)}
        </select>
        <label className="check-field"><input type="checkbox" checked={Boolean(entry.all_day)} onChange={(e) => setEntry({ ...entry, all_day: e.target.checked ? 1 : 0 })} /> All day</label>
      </div>
      <div className="calendar-actions">
        <button onClick={save}>Save changes</button>
        <a className="link-button" href={`/api/calendar/${entry.id}/ics`}>Download .ics</a>
        {entry.capture_id && <a className="link-button" href={`/capture/${entry.capture_id}`}>Open capture</a>}
      </div>
      {message && <p className="toast">{message}</p>}
    </section>
  );
}

function calendarDisplay(entry: CalendarEntry) {
  if (entry.all_day) {
    const date = new Date(`${entry.start_time.slice(0, 10)}T12:00:00Z`);
    return { date: date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }), time: "All day", duration: "All day" };
  }
  const start = new Date(entry.start_time);
  const end = entry.end_time ? new Date(entry.end_time) : new Date(start.getTime() + 30 * 60000);
  const options = { timeZone: entry.timezone || "America/Chicago" };
  const minutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
  const duration = minutes >= 60 ? `${Math.floor(minutes / 60)} hr${minutes % 60 ? ` ${minutes % 60} min` : ""}` : `${minutes} min`;
  return {
    date: start.toLocaleDateString([], { ...options, weekday: "short", month: "short", day: "numeric", year: "numeric" }),
    time: `${start.toLocaleTimeString([], { ...options, hour: "numeric", minute: "2-digit" })}-${end.toLocaleTimeString([], { ...options, hour: "numeric", minute: "2-digit" })}`,
    duration
  };
}

function CaptureDetail({ id }: { id: string }) {
  const [capture, setCapture] = useState<Capture | null>(null);
  const [tags, setTags] = useState("");
  const [actions, setActions] = useState("");
  async function load() {
    const data = await fetch(`/api/captures/${id}`).then((r) => r.json() as Promise<CaptureResponse>);
    setCapture(data.capture);
    setTags((data.capture.tags || []).join(", "));
    setActions((data.capture.action_items || []).map((a: ActionItem) => a.text).join("\n"));
  }
  useEffect(() => { load(); }, [id]);
  if (!capture) return <div>Loading...</div>;
  async function save() {
    await fetch(`/api/captures/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...capture, tags: tags.split(",").map((t) => t.trim()).filter(Boolean), action_items: actions.split("\n").map((text) => ({ text })).filter((a) => a.text.trim()) })
    });
    load();
  }
  async function archive() {
    await fetch(`/api/captures/${id}`, { method: "DELETE" });
    load();
  }
  async function process() {
    await fetch(`/api/captures/${id}/process`, { method: "POST" });
    load();
  }
  return (
    <section className="card editor">
      <textarea className="raw" value={capture.raw_text} onChange={(e) => setCapture({ ...capture, raw_text: e.target.value })} />
      <input placeholder="Title" value={capture.title || ""} onChange={(e) => setCapture({ ...capture, title: e.target.value })} />
      <textarea placeholder="Summary" value={capture.summary || ""} onChange={(e) => setCapture({ ...capture, summary: e.target.value })} />
      <div className="grid">
        <select value={capture.type} onChange={(e) => setCapture({ ...capture, type: e.target.value })}>{typeOptions.map((t) => <option key={t}>{t}</option>)}</select>
        <select value={capture.status} onChange={(e) => setCapture({ ...capture, status: e.target.value })}>{statusOptions.map((s) => <option key={s}>{s}</option>)}</select>
        <select value={capture.priority} onChange={(e) => setCapture({ ...capture, priority: e.target.value })}>{["low", "medium", "high"].map((p) => <option key={p}>{p}</option>)}</select>
        <input type="date" value={capture.due_date || ""} onChange={(e) => setCapture({ ...capture, due_date: e.target.value })} />
      </div>
      <input list="category-options" placeholder="Category" value={capture.category || ""} onChange={(e) => setCapture({ ...capture, category: e.target.value })} />
      <datalist id="category-options">{categoryOptions.map((c) => <option key={c} value={c} />)}</datalist>
      <input placeholder="Tags, comma separated" value={tags} onChange={(e) => setTags(e.target.value)} />
      <textarea placeholder="Action items, one per line" value={actions} onChange={(e) => setActions(e.target.value)} />
      {capture.calendar_entry && (
        <section className="linked-calendar">
          <p className="eyebrow">Linked calendar entry</p>
          <CalendarCard item={capture.calendar_entry} onChanged={load} />
        </section>
      )}
      <div className="capture-actions">
        <button onClick={save}>Save changes</button>
        <button type="button" onClick={process}>Reprocess with AI</button>
        <button type="button" className="muted" onClick={archive}>Archive</button>
      </div>
    </section>
  );
}

function Settings() {
  return (
    <section className="card settings">
      <h1>Settings</h1>
      <div className="settings-grid">
        <div>
          <p><strong>App base URL:</strong> {window.location.origin}</p>
          <p><strong>API capture endpoint:</strong> /api/captures</p>
          <p><strong>Telegram webhook endpoint:</strong> /telegram/webhook</p>
          <p><strong>Ollama chat:</strong> https://chat.gisd.tech</p>
          <p><strong>AI provider status:</strong> AI Off</p>
        </div>
        <ul className="checklist">
          <li>Web capture ready</li>
          <li>API token configured</li>
          <li>Telegram bot configured</li>
          <li>Telegram user authorized</li>
          <li>AI provider configured as none</li>
        </ul>
      </div>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
