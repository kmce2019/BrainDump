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
        {["/feed", "/work", "/tasks", "/ideas", "/reminders", "/review", "/settings"].map((item) => (
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
        {route.startsWith("/capture/") && <CaptureDetail id={route.split("/")[2]} />}
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
      setToast("Saved to your brain dump.");
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
      <textarea id="quick-capture" autoFocus placeholder="What’s on your mind?" value={rawText} onChange={(e) => setRawText(e.target.value)} />
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
  const [stats, setStats] = useState({ today: 0, openTasks: 0, unprocessed: 0, ideasWeek: 0 });
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const query = useMemo(() => {
    const p = new URLSearchParams({ limit: "12", open_only: "1" });
    if (q) p.set("q", q);
    if (type) p.set("type", type);
    return p.toString();
  }, [q, type]);
  async function load() {
    const [recent, statsRes] = await Promise.all([fetch(`/api/captures?${query}`), fetch("/api/stats")]);
    const recentData = await recent.json() as CaptureListResponse;
    const statsData = await statsRes.json() as StatsResponse;
    setItems(recentData.captures || []);
    setStats(statsData);
  }
  useEffect(() => { load(); }, [query]);
  return (
    <div className="dashboard-grid">
      <section className="main-column">
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">BrainDump</p>
            <h1>Send it now. Sort it later.</h1>
            <p>Capture thoughts, tasks, ideas, reminders, and project fragments from the web, Telegram, or your phone shortcut.</p>
          </div>
          <QuickCapture onSaved={load} />
          <p className="helper-text">Saved instantly. Organized later.</p>
          <StatusPills />
        </section>
        <FeedControls q={q} setQ={setQ} type={type} setType={setType} />
        <div className="section-head">
          <h2>Latest dumps</h2>
          <button className="ghost" onClick={() => nav("/feed")}>Open feed</button>
        </div>
        <CaptureList items={items} />
      </section>
      <RightPanel stats={stats} />
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
  initialStatus = "",
  includeClosed = false
}: {
  fixedType?: string;
  title?: string;
  processingStatus?: string;
  includePendingActions?: boolean;
  fixedCategory?: string;
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
    if (processingStatus) p.set("processing_status", processingStatus);
    if (includePendingActions) p.set("pending_actions", "1");
    return p.toString();
  }, [q, status, source, type, fixedCategory, processingStatus, includePendingActions, includeClosed]);
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
        <span className={`type-badge ${item.type}`}>#{item.type}</span>
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
      <input id="capture-search" className="search" placeholder="Search by text, tag, source, or date..." value={q} onChange={(e) => setQ(e.target.value)} />
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

function RightPanel({ stats }: { stats: StatsResponse }) {
  return (
    <aside className="right-panel">
      <section className="card ready-card">
        <p className="eyebrow">Always ready</p>
        <h2>Capture first. Decide later.</h2>
        <p>Send anything from Telegram, web, or your phone shortcut and it lands here.</p>
        <StatusPills />
      </section>
      <section className="mini-stats">
        <Stat label="Captures today" value={stats.today} />
        <Stat label="Open tasks" value={stats.openTasks} />
        <Stat label="Ideas this week" value={stats.ideasWeek} />
        <Stat label="Unprocessed" value={stats.unprocessed} />
      </section>
      <section className="card telegram-card">
        <span className="type-badge reminder">#telegram</span>
        <h2>Telegram Capture</h2>
        <p>Send a message to your bot and it appears in your feed.</p>
      </section>
    </aside>
  );
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
