type AiProvider = "none" | "ollama" | "workers_ai";
type CaptureType = "note" | "task" | "idea" | "reminder" | "question" | "project";

type Env = {
  DB?: D1Database;
  ASSETS?: Fetcher;
  PROCESS_QUEUE?: Queue<{ capture_id: string }>;
  AI?: { run: (model: string, input: unknown) => Promise<unknown> };
  APP_PASSWORD?: string;
  APP_BASE_URL?: string;
  CAPTURE_API_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ALLOWED_TELEGRAM_USER_ID?: string;
  AI_PROVIDER?: AiProvider;
  OLLAMA_BASE_URL?: string;
  OLLAMA_MODEL?: string;
  WORKERS_AI_MODEL?: string;
  USER_TIMEZONE?: string;
};

type Capture = {
  id: string;
  raw_text: string;
  source: string;
  title?: string | null;
  summary?: string | null;
  type: CaptureType;
  category?: string | null;
  priority: string;
  due_date?: string | null;
  status: string;
  processing_status: string;
  ai_error?: string | null;
  created_at: string;
  updated_at: string;
  external_user_id?: string | null;
  external_chat_id?: string | null;
  external_message_id?: string | null;
  metadata_json?: string | null;
};

const captureTypes = new Set(["note", "task", "idea", "reminder", "question", "project"]);
const statuses = new Set(["inbox", "active", "done", "dismissed", "archived"]);
const processingStatuses = new Set(["unprocessed", "queued", "processing", "processed", "failed"]);
const sources = new Set(["web", "api", "shortcut", "telegram", "email", "sms"]);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") return json({ ok: true, db: Boolean(env.DB) });
      if (url.pathname === "/api/login" && request.method === "POST") return login(request, env);
      if (url.pathname === "/api/logout" && request.method === "POST") return logout();
      if (url.pathname === "/api/session") return (await isWebAuthed(request, env)) ? json({ ok: true }) : json({ ok: false }, 401);
      if (url.pathname === "/telegram/webhook" && request.method === "POST") return telegramWebhook(request, env, ctx);

      if (url.pathname.startsWith("/api/")) {
        if (!(await isAuthed(request, env))) return json({ ok: false, error: "Unauthorized" }, 401);
        if (url.pathname === "/api/stats" && request.method === "GET") return stats(env);
        if (url.pathname === "/api/captures" && request.method === "POST") return createCaptureRoute(request, env, ctx);
        if (url.pathname === "/api/captures" && request.method === "GET") return listCaptures(url, env);

        const match = url.pathname.match(/^\/api\/captures\/([^/]+)(?:\/(process))?$/);
        if (match && request.method === "GET" && !match[2]) return getCapture(match[1], env);
        if (match && request.method === "PATCH" && !match[2]) return updateCapture(match[1], request, env);
        if (match && request.method === "DELETE" && !match[2]) return deleteCapture(match[1], url, env, request);
        if (match && request.method === "POST" && match[2] === "process") return processCaptureRoute(match[1], env);
        return json({ ok: false, error: "Not found" }, 404);
      }

      return env.ASSETS ? env.ASSETS.fetch(request) : new Response("BrainDump Worker is running.", { headers: { "content-type": "text/plain" } });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      return json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, status);
    }
  },

  async queue(batch: MessageBatch<{ capture_id: string }>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await processCaptureById(message.body.capture_id, env);
      message.ack();
    }
  }
};

async function login(request: Request, env: Env) {
  const body = await safeJson(request);
  if (!env.APP_PASSWORD || body.password !== env.APP_PASSWORD) return json({ ok: false }, 401);
  const token = await sessionToken(env);
  return json({ ok: true }, 200, {
    "Set-Cookie": `bd_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`
  });
}

function logout() {
  return json({ ok: true }, 200, {
    "Set-Cookie": "bd_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"
  });
}

async function isAuthed(request: Request, env: Env) {
  const auth = request.headers.get("Authorization") || "";
  if (env.CAPTURE_API_TOKEN && auth === `Bearer ${env.CAPTURE_API_TOKEN}`) return true;
  return isWebAuthed(request, env);
}

async function isWebAuthed(request: Request, env: Env) {
  if (!env.APP_PASSWORD) return false;
  const cookie = request.headers.get("Cookie") || "";
  const token = cookie.split(";").map((v) => v.trim()).find((v) => v.startsWith("bd_session="))?.slice("bd_session=".length);
  return Boolean(token && token === await sessionToken(env));
}

async function sessionToken(env: Env) {
  const input = new TextEncoder().encode(`braindump-session:${env.APP_PASSWORD}`);
  const hash = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function createCaptureRoute(request: Request, env: Env, ctx: ExecutionContext) {
  const body = await safeJson(request);
  const capture = await createCapture(env, {
    raw_text: body.raw_text,
    source: sanitizeSource(body.source),
    type: sanitizeType(body.type_hint),
    category: sanitizeCategory(body.category),
    metadata: body.metadata || {}
  });
  queueProcessing(env, ctx, capture.id);
  return json({ ok: true, capture: publicCapture(capture) });
}

async function createCapture(env: Env, input: {
  raw_text: string;
  source: string;
  type: CaptureType;
  category?: string | null;
  metadata?: unknown;
  external_user_id?: string;
  external_chat_id?: string;
  external_message_id?: string;
}) {
  requireDb(env);
  const raw = String(input.raw_text || "").trim();
  if (!raw) throw new HttpError("raw_text is required", 400);
  const now = new Date().toISOString();
  const capture: Capture = {
    id: crypto.randomUUID(),
    raw_text: raw,
    source: input.source,
    type: input.type,
    category: input.category || null,
    priority: "medium",
    status: "inbox",
    processing_status: aiProvider(env) === "none" ? "unprocessed" : "queued",
    created_at: now,
    updated_at: now,
    external_user_id: input.external_user_id || null,
    external_chat_id: input.external_chat_id || null,
    external_message_id: input.external_message_id || null,
    metadata_json: JSON.stringify(input.metadata || {})
  };
  await env.DB!.prepare(
    `INSERT INTO captures (id, raw_text, source, type, category, priority, status, processing_status, created_at, updated_at, external_user_id, external_chat_id, external_message_id, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(capture.id, capture.raw_text, capture.source, capture.type, capture.category, capture.priority, capture.status, capture.processing_status, capture.created_at, capture.updated_at, capture.external_user_id, capture.external_chat_id, capture.external_message_id, capture.metadata_json).run();
  return capture;
}

function queueProcessing(env: Env, ctx: ExecutionContext, captureId: string) {
  if (aiProvider(env) === "none" || !env.PROCESS_QUEUE) return;
  ctx.waitUntil(env.PROCESS_QUEUE.send({ capture_id: captureId }).catch(async () => {
    if (env.DB) await env.DB.prepare("UPDATE captures SET processing_status='unprocessed', updated_at=? WHERE id=?").bind(new Date().toISOString(), captureId).run();
  }));
}

async function listCaptures(url: URL, env: Env) {
  requireDb(env);
  const where: string[] = [];
  const args: unknown[] = [];
  addFilter(where, args, "type", url.searchParams.get("type"), captureTypes);
  addFilter(where, args, "status", url.searchParams.get("status"), statuses);
  addFilter(where, args, "source", url.searchParams.get("source"));
  addFilter(where, args, "processing_status", url.searchParams.get("processing_status"), processingStatuses);
  where.push("NOT (source='telegram' AND lower(trim(raw_text)) IN ('/search', '/help', '/start', '/today'))");
  const category = sanitizeCategory(url.searchParams.get("category"));
  if (category) {
    where.push("lower(category)=lower(?)");
    args.push(category);
  }
  if (!url.searchParams.get("status") && url.searchParams.get("open_only") === "1") {
    where.push("status IN ('inbox', 'active')");
  }
  const q = url.searchParams.get("q")?.trim();
  if (q) {
    where.push("(raw_text LIKE ? OR title LIKE ? OR summary LIKE ? OR category LIKE ?)");
    args.push(...Array(4).fill(`%${q}%`));
  }
  if (url.searchParams.get("pending_actions") === "1") {
    where.push("(type='task' OR id IN (SELECT capture_id FROM action_items WHERE status='pending'))");
  }
  const limit = Math.min(Number(url.searchParams.get("limit") || 50), 100);
  const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);
  const sql = `SELECT * FROM captures ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  const result = await env.DB!.prepare(sql).bind(...args, limit, offset).all<Capture>();
  return json({ ok: true, captures: result.results || [] });
}

async function getCapture(id: string, env: Env) {
  const capture = await readCapture(id, env);
  if (!capture) return json({ ok: false, error: "Not found" }, 404);
  const [tags, actions] = await Promise.all([readTags(id, env), readActionItems(id, env)]);
  return json({ ok: true, capture: { ...capture, tags, action_items: actions } });
}

async function updateCapture(id: string, request: Request, env: Env) {
  requireDb(env);
  const body = await safeJson(request);
  const current = await readCapture(id, env);
  if (!current) return json({ ok: false, error: "Not found" }, 404);
  const next = {
    raw_text: body.raw_text ?? current.raw_text,
    title: body.title ?? current.title,
    summary: body.summary ?? current.summary,
    type: sanitizeType(body.type || current.type),
    category: body.category ?? current.category,
    priority: ["low", "medium", "high"].includes(body.priority) ? body.priority : current.priority,
    due_date: body.due_date ?? current.due_date,
    status: statuses.has(body.status) ? body.status : current.status,
    updated_at: new Date().toISOString()
  };
  await env.DB!.prepare(
    `UPDATE captures SET raw_text=?, title=?, summary=?, type=?, category=?, priority=?, due_date=?, status=?, updated_at=? WHERE id=?`
  ).bind(next.raw_text, next.title, next.summary, next.type, next.category, next.priority, next.due_date, next.status, next.updated_at, id).run();
  if (Array.isArray(body.tags)) await replaceTags(id, body.tags, env);
  if (Array.isArray(body.action_items)) await replaceActionItems(id, body.action_items, env);
  return getCapture(id, env);
}

async function deleteCapture(id: string, url: URL, env: Env, request: Request) {
  requireDb(env);
  if (url.searchParams.get("hard") === "true" && await isWebAuthed(request, env)) {
    await env.DB!.batch([
      env.DB!.prepare("DELETE FROM capture_tags WHERE capture_id=?").bind(id),
      env.DB!.prepare("DELETE FROM action_items WHERE capture_id=?").bind(id),
      env.DB!.prepare("DELETE FROM captures WHERE id=?").bind(id)
    ]);
    return json({ ok: true, hard_deleted: true });
  }
  await env.DB!.prepare("UPDATE captures SET status='archived', updated_at=? WHERE id=?").bind(new Date().toISOString(), id).run();
  return json({ ok: true, archived: true });
}

async function processCaptureRoute(id: string, env: Env) {
  await processCaptureById(id, env);
  return getCapture(id, env);
}

async function stats(env: Env) {
  requireDb(env);
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const row = await env.DB!.prepare(
    `SELECT
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS today,
      SUM(CASE WHEN type='task' AND status NOT IN ('done','archived','dismissed') THEN 1 ELSE 0 END) AS openTasks,
      SUM(CASE WHEN processing_status='unprocessed' THEN 1 ELSE 0 END) AS unprocessed,
      SUM(CASE WHEN type='idea' AND created_at >= ? THEN 1 ELSE 0 END) AS ideasWeek
     FROM captures`
  ).bind(`${today}T00:00:00.000Z`, weekAgo).first<Record<string, number>>();
  return json(row || { today: 0, openTasks: 0, unprocessed: 0, ideasWeek: 0 });
}

async function telegramWebhook(request: Request, env: Env, ctx: ExecutionContext) {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });
  const update = await safeJson(request);
  const message = update.message || update.edited_message;
  if (!message?.chat?.id || !message.from?.id) return json({ ok: true });
  const chatId = String(message.chat.id);
  const userId = String(message.from.id);
  const text = String(message.text || "").trim();
  const command = telegramCommand(text);
  const allowed = !env.ALLOWED_TELEGRAM_USER_ID || env.ALLOWED_TELEGRAM_USER_ID === userId;

  if (!allowed) {
    ctx.waitUntil(sendTelegramMessage(env, chatId, "Sorry, this bot is private."));
    return json({ ok: true });
  }

  if (command.name === "/start") {
    const extra = env.ALLOWED_TELEGRAM_USER_ID === userId ? "\n\nYou are authorized. Send me anything and I will capture it." : "";
    ctx.waitUntil(sendTelegramMessage(env, chatId, `BrainDump is connected. Your Telegram user ID is ${userId}. Add this as ALLOWED_TELEGRAM_USER_ID in Cloudflare if you have not already.${extra}`));
    return json({ ok: true });
  }
  if (command.name === "/help") {
    ctx.waitUntil(sendTelegramMessage(env, chatId, "Send any message to capture it.\n/work order lift\n/task buy printer paper\n/idea local property photo service\n/remind call vendor Monday\n/today\n/search freepbx"));
    return json({ ok: true });
  }
  if (command.name === "/today") return telegramToday(env, ctx, chatId);
  if (command.name === "/search" && !command.args) {
    ctx.waitUntil(sendTelegramMessage(env, chatId, "Use /search <query>."));
    return json({ ok: true });
  }
  if (command.name === "/search") return telegramSearch(env, ctx, chatId, command.args);
  if (!text) return json({ ok: true });

  const parsed = parseTelegramText(text);
  const capture = await createCapture(env, {
    raw_text: parsed.raw_text,
    source: "telegram",
    type: parsed.type,
    category: parsed.category,
    external_user_id: userId,
    external_chat_id: chatId,
    external_message_id: String(message.message_id || ""),
    metadata: {
      username: message.from.username || null,
      first_name: message.from.first_name || null,
      chat_type: message.chat.type || null,
      date: message.date || null
    }
  });
  queueProcessing(env, ctx, capture.id);
  ctx.waitUntil(sendTelegramMessage(env, chatId, `Captured: ${simpleTitle(capture.raw_text)}`));
  return json({ ok: true });
}

async function telegramToday(env: Env, ctx: ExecutionContext, chatId: string) {
  requireDb(env);
  const today = new Date().toISOString().slice(0, 10);
  const rows = await env.DB!.prepare("SELECT * FROM captures WHERE created_at >= ? ORDER BY created_at DESC LIMIT 10").bind(`${today}T00:00:00.000Z`).all<Capture>();
  const text = rows.results?.length ? rows.results.map((c, i) => `${i + 1}. ${simpleTitle(c.title || c.raw_text)}`).join("\n") : "No captures today.";
  ctx.waitUntil(sendTelegramMessage(env, chatId, text));
  return json({ ok: true });
}

async function telegramSearch(env: Env, ctx: ExecutionContext, chatId: string, query: string) {
  requireDb(env);
  if (!query) {
    ctx.waitUntil(sendTelegramMessage(env, chatId, "Use /search <query>."));
    return json({ ok: true });
  }
  const rows = await env.DB!.prepare("SELECT * FROM captures WHERE raw_text LIKE ? OR title LIKE ? OR summary LIKE ? ORDER BY created_at DESC LIMIT 5").bind(`%${query}%`, `%${query}%`, `%${query}%`).all<Capture>();
  const text = rows.results?.length ? rows.results.map((c, i) => `${i + 1}. ${simpleTitle(c.title || c.raw_text)}`).join("\n") : "No matches.";
  ctx.waitUntil(sendTelegramMessage(env, chatId, text));
  return json({ ok: true });
}

function parseTelegramText(text: string): { type: CaptureType; category?: string | null; raw_text: string } {
  const commands: Record<string, CaptureType> = { "/task": "task", "/idea": "idea", "/remind": "reminder", "/project": "project", "/question": "question", "/note": "note" };
  const command = telegramCommand(text);
  if (commands[command.name]) return { type: commands[command.name], raw_text: command.args || text };
  if (command.name === "/work") return { type: "task", category: "work", raw_text: command.args || text };
  return { type: "note", raw_text: text };
}

function telegramCommand(text: string) {
  const [cmd = "", ...rest] = text.trim().split(/\s+/);
  return {
    name: cmd.toLowerCase().split("@")[0],
    args: rest.join(" ").trim()
  };
}

async function sendTelegramMessage(env: Env, chatId: string, text: string) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

async function processCaptureById(id: string, env: Env) {
  const capture = await readCapture(id, env);
  if (!capture) return;
  await processCapture(capture, env);
}

export async function processCapture(capture: Capture, env: Env) {
  requireDb(env);
  const provider = aiProvider(env);
  if (provider === "none") {
    await env.DB!.prepare("UPDATE captures SET processing_status='unprocessed', updated_at=? WHERE id=?").bind(new Date().toISOString(), capture.id).run();
    return;
  }
  await env.DB!.prepare("UPDATE captures SET processing_status='processing', ai_error=NULL, updated_at=? WHERE id=?").bind(new Date().toISOString(), capture.id).run();
  try {
    const result = provider === "ollama" ? await processWithOllama(capture, env) : await processWithWorkersAi(capture, env);
    await applyAiResult(capture.id, result, env);
  } catch (error) {
    await env.DB!.prepare("UPDATE captures SET processing_status='failed', ai_error=?, updated_at=? WHERE id=?").bind(error instanceof Error ? error.message : "AI processing failed", new Date().toISOString(), capture.id).run();
  }
}

async function processWithOllama(capture: Capture, env: Env) {
  const base = (env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/$/, "");
  const response = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: env.OLLAMA_MODEL || "llama3.1", prompt: aiPrompt(capture.raw_text), stream: false, format: "json" })
  });
  if (!response.ok) throw new Error(`Ollama failed: ${response.status}`);
  const data = await response.json<{ response?: string }>();
  return parseAiJson(data.response || "");
}

async function processWithWorkersAi(capture: Capture, env: Env) {
  if (!env.AI) throw new Error("Workers AI binding is missing");
  const output = await env.AI.run(env.WORKERS_AI_MODEL || "@cf/meta/llama-3.1-8b-instruct", {
    messages: [
      { role: "system", content: "You organize a private thought inbox. Convert messy user captures into useful structured notes. Do not invent facts. If no due date is clear, use null. If unsure of type, use note. Return valid JSON only." },
      { role: "user", content: aiPrompt(capture.raw_text) }
    ]
  });
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return parseAiJson(text);
}

function aiPrompt(rawText: string) {
  return `Return JSON only with this shape: {"title":"","summary":"","type":"task|idea|reminder|note|question|project","category":"","priority":"low|medium|high","due_date":null,"tags":[],"action_items":[{"text":"","due_date":null}]}.\n\nCapture:\n${rawText}`;
}

function parseAiJson(text: string) {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("AI returned invalid JSON");
  const parsed = JSON.parse(trimmed.slice(start, end + 1));
  if (!captureTypes.has(parsed.type)) parsed.type = "note";
  if (!["low", "medium", "high"].includes(parsed.priority)) parsed.priority = "medium";
  parsed.tags = Array.isArray(parsed.tags) ? parsed.tags : [];
  parsed.action_items = Array.isArray(parsed.action_items) ? parsed.action_items : [];
  return parsed;
}

async function applyAiResult(id: string, result: Record<string, unknown>, env: Env) {
  const now = new Date().toISOString();
  await env.DB!.prepare(
    `UPDATE captures SET title=?, summary=?, type=?, category=?, priority=?, due_date=?, processing_status='processed', ai_error=NULL, updated_at=? WHERE id=?`
  ).bind(result.title || null, result.summary || null, result.type || "note", result.category || null, result.priority || "medium", result.due_date || null, now, id).run();
  await replaceTags(id, (result.tags as string[]) || [], env);
  await replaceActionItems(id, (result.action_items as { text: string; due_date?: string | null }[]) || [], env);
}

async function readCapture(id: string, env: Env) {
  requireDb(env);
  return env.DB!.prepare("SELECT * FROM captures WHERE id=?").bind(id).first<Capture>();
}

async function readTags(id: string, env: Env) {
  const rows = await env.DB!.prepare("SELECT tags.name FROM tags JOIN capture_tags ON tags.id=capture_tags.tag_id WHERE capture_tags.capture_id=? ORDER BY tags.name").bind(id).all<{ name: string }>();
  return (rows.results || []).map((r) => r.name);
}

async function readActionItems(id: string, env: Env) {
  const rows = await env.DB!.prepare("SELECT * FROM action_items WHERE capture_id=? ORDER BY created_at").bind(id).all();
  return rows.results || [];
}

async function replaceTags(captureId: string, tags: string[], env: Env) {
  const clean = [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
  const now = new Date().toISOString();
  await env.DB!.prepare("DELETE FROM capture_tags WHERE capture_id=?").bind(captureId).run();
  for (const name of clean) {
    const id = await tagId(name);
    await env.DB!.prepare("INSERT OR IGNORE INTO tags (id, name, created_at) VALUES (?, ?, ?)").bind(id, name, now).run();
    await env.DB!.prepare("INSERT OR IGNORE INTO capture_tags (capture_id, tag_id) VALUES (?, ?)").bind(captureId, id).run();
  }
}

async function replaceActionItems(captureId: string, items: { text: string; due_date?: string | null; status?: string }[], env: Env) {
  const now = new Date().toISOString();
  await env.DB!.prepare("DELETE FROM action_items WHERE capture_id=?").bind(captureId).run();
  for (const item of items) {
    const text = String(item.text || "").trim();
    if (!text) continue;
    await env.DB!.prepare("INSERT INTO action_items (id, capture_id, text, status, due_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), captureId, text, item.status || "pending", item.due_date || null, now, now).run();
  }
}

async function tagId(name: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name));
  return [...new Uint8Array(hash)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function addFilter(where: string[], args: unknown[], field: string, value: string | null, allowed?: Set<string>) {
  if (!value || (allowed && !allowed.has(value))) return;
  where.push(`${field}=?`);
  args.push(value);
}

function sanitizeType(value: unknown): CaptureType {
  const type = String(value || "note");
  return captureTypes.has(type) ? type as CaptureType : "note";
}

function sanitizeSource(value: unknown) {
  const source = String(value || "api");
  return sources.has(source) ? source : "api";
}

function sanitizeCategory(value: unknown) {
  const category = String(value || "").trim().toLowerCase();
  return category || null;
}

function aiProvider(env: Env): AiProvider {
  return (env.AI_PROVIDER || "none") as AiProvider;
}

function publicCapture(capture: Capture) {
  return {
    id: capture.id,
    raw_text: capture.raw_text,
    title: capture.title || null,
    source: capture.source,
    created_at: capture.created_at
  };
}

function simpleTitle(text: string) {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

async function safeJson(request: Request) {
  try {
    return await request.json<Record<string, any>>();
  } catch {
    return {};
  }
}

function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

function requireDb(env: Env) {
  if (!env.DB) throw new HttpError("D1 DB binding is not configured", 500);
}

class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
