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
const statusOptions = ["inbox", "active", "done", "dismissed", "archived"];

function preview(capture: Capture) {
  return capture.title || capture.raw_text.slice(0, 120);
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
        <button className="brand" onClick={() => nav("/")}>BrainDump</button>
        {["/", "/capture", "/feed", "/tasks", "/ideas", "/reminders", "/projects", "/review", "/settings"].map((item) => (
          <button key={item} className={route === item ? "active" : ""} onClick={() => nav(item)}>
            {item === "/" ? "Dashboard" : item.slice(1)}
          </button>
        ))}
      </aside>
      <main className="shell">
        {route === "/" && <Dashboard nav={nav} />}
        {route === "/capture" && <CapturePage />}
        {route === "/feed" && <Feed />}
        {route === "/tasks" && <Feed fixedType="task" title="Tasks" includePendingActions />}
        {route === "/ideas" && <Feed fixedType="idea" title="Ideas" />}
        {route === "/reminders" && <Feed fixedType="reminder" title="Reminders" />}
        {route === "/projects" && <Feed fixedType="project" title="Projects" />}
        {route === "/review" && <Feed processingStatus="processed" title="Review" />}
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
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!rawText.trim()) return;
    setSaving(true);
    const res = await fetch("/api/captures", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw_text: rawText, source: "web", type_hint: type })
    });
    setSaving(false);
    if (res.ok) {
      setRawText("");
      onSaved?.();
    }
  }
  return (
    <form className="card capture-card" onSubmit={submit}>
      <textarea autoFocus placeholder="Drop a thought, task, reminder, idea, or question..." value={rawText} onChange={(e) => setRawText(e.target.value)} />
      <div className="capture-actions">
        <select value={type} onChange={(e) => setType(e.target.value)}>{typeOptions.map((t) => <option key={t}>{t}</option>)}</select>
        <button disabled={saving || !rawText.trim()}>{saving ? "Saving..." : "Save capture"}</button>
      </div>
    </form>
  );
}

function Dashboard({ nav }: { nav: (to: string) => void }) {
  const [items, setItems] = useState<Capture[]>([]);
  const [stats, setStats] = useState({ today: 0, openTasks: 0, unprocessed: 0, ideasWeek: 0 });
  async function load() {
    const [recent, statsRes] = await Promise.all([fetch("/api/captures?limit=8"), fetch("/api/stats")]);
    const recentData = await recent.json() as CaptureListResponse;
    const statsData = await statsRes.json() as StatsResponse;
    setItems(recentData.captures || []);
    setStats(statsData);
  }
  useEffect(() => { load(); }, []);
  return (
    <>
      <header className="topline"><h1>Private capture inbox</h1><button onClick={() => nav("/feed")}>Open feed</button></header>
      <QuickCapture onSaved={load} />
      <section className="stats">
        <Stat label="Today" value={stats.today} />
        <Stat label="Open tasks" value={stats.openTasks} />
        <Stat label="Unprocessed" value={stats.unprocessed} />
        <Stat label="Ideas this week" value={stats.ideasWeek} />
      </section>
      <CaptureList items={items} />
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="card stat"><strong>{value}</strong><span>{label}</span></div>;
}

function CapturePage() {
  return <><h1>Quick Capture</h1><QuickCapture /></>;
}

function Feed({ fixedType, title = "Feed", processingStatus, includePendingActions }: { fixedType?: string; title?: string; processingStatus?: string; includePendingActions?: boolean }) {
  const [items, setItems] = useState<Capture[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [type, setType] = useState(fixedType || "");
  const query = useMemo(() => {
    const p = new URLSearchParams({ limit: "50" });
    if (q) p.set("q", q);
    if (status) p.set("status", status);
    if (source) p.set("source", source);
    if (type) p.set("type", type);
    if (processingStatus) p.set("processing_status", processingStatus);
    if (includePendingActions) p.set("pending_actions", "1");
    return p.toString();
  }, [q, status, source, type, processingStatus, includePendingActions]);
  useEffect(() => { fetch(`/api/captures?${query}`).then((r) => r.json() as Promise<CaptureListResponse>).then((d) => setItems(d.captures || [])); }, [query]);
  return (
    <>
      <header className="topline"><h1>{title}</h1></header>
      <div className="card filters">
        <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        {!fixedType && <select value={type} onChange={(e) => setType(e.target.value)}><option value="">Any type</option>{typeOptions.map((t) => <option key={t}>{t}</option>)}</select>}
        <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any status</option>{statusOptions.map((s) => <option key={s}>{s}</option>)}</select>
        <input placeholder="Source" value={source} onChange={(e) => setSource(e.target.value)} />
      </div>
      <CaptureList items={items} />
    </>
  );
}

function CaptureList({ items }: { items: Capture[] }) {
  if (!items.length) return <div className="empty">No captures yet.</div>;
  return <section className="list">{items.map((item) => <CaptureRow key={item.id} item={item} />)}</section>;
}

function CaptureRow({ item }: { item: Capture }) {
  return (
    <a className="card row" href={`/capture/${item.id}`} onClick={(e) => { e.preventDefault(); history.pushState(null, "", `/capture/${item.id}`); dispatchEvent(new PopStateEvent("popstate")); }}>
      <h2>{preview(item)}</h2>
      <p>{item.summary || item.raw_text}</p>
      <div className="badges">
        {[item.type, item.source, item.status, item.processing_status, ...(item.tags || [])].map((b) => <span key={b}>{b}</span>)}
      </div>
    </a>
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
      <input placeholder="Category" value={capture.category || ""} onChange={(e) => setCapture({ ...capture, category: e.target.value })} />
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
      <p><strong>Capture API:</strong> /api/captures</p>
      <p><strong>Telegram webhook:</strong> /telegram/webhook</p>
      <ul>
        <li>Set APP_PASSWORD and CAPTURE_API_TOKEN as Cloudflare secrets.</li>
        <li>Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, and ALLOWED_TELEGRAM_USER_ID for Telegram.</li>
        <li>Keep AI_PROVIDER=none unless Ollama or Workers AI is configured.</li>
      </ul>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
