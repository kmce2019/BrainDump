import { formatCalendarDateTime, generateIcs, parseCalendarText } from "./calendar";

type AiProvider = "none" | "ollama" | "workers_ai";
type CaptureType = "note" | "task" | "idea" | "reminder" | "question" | "project";
type CalendarStatus = "pending" | "exported" | "created" | "canceled" | "failed";

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
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
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
  tags?: string[];
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
  status: CalendarStatus;
  source: string;
  external_calendar_id?: string | null;
  external_event_id?: string | null;
  ics_uid: string;
  created_at: string;
  updated_at: string;
  metadata_json?: string | null;
  capture_preview?: string | null;
};

const captureTypes = new Set(["note", "task", "idea", "reminder", "question", "project"]);
const statuses = new Set(["inbox", "active", "done", "dismissed", "archived"]);
const processingStatuses = new Set(["unprocessed", "queued", "processing", "processed", "failed"]);
const sources = new Set(["web", "api", "shortcut", "telegram", "email", "sms"]);
const calendarStatuses = new Set<CalendarStatus>(["pending", "exported", "created", "canceled", "failed"]);
let calendarSchemaPromise: Promise<void> | null = null;
let calendarOauthSchemaPromise: Promise<void> | null = null;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") return json({ ok: true, db: Boolean(env.DB) });
      if (url.pathname === "/api/login" && request.method === "POST") return login(request, env);
      if (url.pathname === "/api/logout" && request.method === "POST") return logout();
      if (url.pathname === "/api/session") return (await isWebAuthed(request, env)) ? json({ ok: true }) : json({ ok: false }, 401);
      if (url.pathname === "/api/auth/google/callback" && request.method === "GET") return googleOauthCallback(request, env);
      if (url.pathname === "/telegram/webhook" && request.method === "POST") return telegramWebhook(request, env, ctx);

      if (url.pathname.startsWith("/api/")) {
        if (!(await isAuthed(request, env))) return json({ ok: false, error: "Unauthorized" }, 401);
        if (url.pathname === "/api/stats" && request.method === "GET") return stats(env);
        if (url.pathname === "/api/tags" && request.method === "GET") return listTags(env);
        if (url.pathname === "/api/captures" && request.method === "POST") return createCaptureRoute(request, env, ctx);
        if (url.pathname === "/api/captures" && request.method === "GET") return listCaptures(url, env);
        if (url.pathname === "/api/calendar" && request.method === "GET") return listCalendarEntries(url, env);
        if (url.pathname === "/api/calendar/google/status" && request.method === "GET") return googleCalendarStatus(env);
        if (url.pathname === "/api/calendar/google/connect" && request.method === "GET") return googleOauthConnect(env);
        if (url.pathname === "/api/calendar/google/disconnect" && request.method === "POST") return googleOauthDisconnect(env);

        const fromCaptureMatch = url.pathname.match(/^\/api\/calendar\/from-capture\/([^/]+)$/);
        if (fromCaptureMatch && request.method === "POST") return createCalendarFromCapture(fromCaptureMatch[1], env);

        const calendarMatch = url.pathname.match(/^\/api\/calendar\/([^/]+)(?:\/(ics|google))?$/);
        if (calendarMatch && request.method === "GET" && calendarMatch[2] === "ics") return calendarIcs(calendarMatch[1], env);
        if (calendarMatch && request.method === "POST" && calendarMatch[2] === "google") return createGoogleCalendarEvent(calendarMatch[1], env);
        if (calendarMatch && request.method === "GET" && !calendarMatch[2]) return getCalendarEntry(calendarMatch[1], env);
        if (calendarMatch && request.method === "PATCH" && !calendarMatch[2]) return updateCalendarEntry(calendarMatch[1], request, env);
        if (calendarMatch && request.method === "DELETE" && !calendarMatch[2]) return cancelCalendarEntry(calendarMatch[1], env);

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
  capture.tags = await replaceTags(capture.id, [...tagsFromText(capture.raw_text), input.category].filter(Boolean) as string[], env);
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
  const tag = sanitizeTag(url.searchParams.get("tag"));
  if (tag) {
    where.push("(lower(category)=lower(?) OR id IN (SELECT capture_id FROM capture_tags JOIN tags ON tags.id=capture_tags.tag_id WHERE tags.name=?))");
    args.push(tag, tag);
  }
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
  const captures = await withTags(result.results || [], env);
  return json({ ok: true, captures });
}

async function listTags(env: Env) {
  requireDb(env);
  const rows = await env.DB!.prepare(
    `SELECT name, SUM(count) AS count
     FROM (
       SELECT tags.name AS name, COUNT(capture_tags.capture_id) AS count
       FROM tags
       LEFT JOIN capture_tags ON capture_tags.tag_id=tags.id
       GROUP BY tags.id, tags.name
       UNION ALL
       SELECT lower(category) AS name, COUNT(*) AS count
       FROM captures
       WHERE category IS NOT NULL AND trim(category) != ''
       GROUP BY lower(category)
     )
     GROUP BY name
     ORDER BY count DESC, name
     LIMIT 100`
  ).all<{ name: string; count: number }>();
  return json({ ok: true, tags: rows.results || [] });
}

async function getCapture(id: string, env: Env) {
  const capture = await readCapture(id, env);
  if (!capture) return json({ ok: false, error: "Not found" }, 404);
  const [tags, actions, calendarEntry] = await Promise.all([readTags(id, env), readActionItems(id, env), readCalendarByCapture(id, env)]);
  return json({ ok: true, capture: { ...capture, tags, action_items: actions, calendar_entry: calendarEntry } });
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
    ctx.waitUntil(sendTelegramMessage(env, chatId, "Send any message to capture it as a note. Add hashtags to file it in multiple places.\n\n/work order lift #warehouse\n/task buy printer paper #work #office\n/idea local property photo service #business\n/remind call vendor Monday #work\n/cal tomorrow 9am call vendor\n/schedule Friday 3pm-4pm work session\n/today\n/search freepbx"));
    return json({ ok: true });
  }
  if (command.name === "/today") return telegramToday(env, ctx, chatId);
  if (command.name === "/search" && !command.args) {
    ctx.waitUntil(sendTelegramMessage(env, chatId, "Use /search <query>."));
    return json({ ok: true });
  }
  if (command.name === "/search") return telegramSearch(env, ctx, chatId, command.args);
  if (!text) return json({ ok: true });

  const calendarCommand = ["/cal", "/calendar", "/schedule", "/event"].includes(command.name);
  const parsed = parseTelegramText(text);
  const capture = await createCapture(env, {
    raw_text: calendarCommand ? text : parsed.raw_text,
    source: "telegram",
    type: calendarCommand ? "reminder" : parsed.type,
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
  if (calendarCommand) {
    const calendarEntry = await createCalendarEntryFromText(capture, command.args, env);
    queueProcessing(env, ctx, capture.id);
    if (!calendarEntry) {
      ctx.waitUntil(sendTelegramMessage(env, chatId, "I saved that, but couldn't find a clear date/time. Try: /cal tomorrow 9am call vendor."));
      return json({ ok: true });
    }
    const display = formatCalendarDateTime(calendarEntry);
    const baseUrl = (env.APP_BASE_URL || "").replace(/\/$/, "");
    const detailLink = baseUrl ? `\n${baseUrl}/calendar/${calendarEntry.id}` : "";
    const googleCredentials = await readGoogleCredentials(env);
    if (googleCredentials?.refresh_token || googleCredentials?.access_token) {
      try {
        const googleEvent = await insertGoogleCalendarEvent(calendarEntry, env);
        const googleLink = googleEvent.html_link ? `\n${googleEvent.html_link}` : "";
        ctx.waitUntil(sendTelegramMessage(env, chatId, `Created in Google Calendar:\n${calendarEntry.title}\n${display.date}\n${display.time} (${display.duration})${googleLink}${detailLink}`));
      } catch (error) {
        ctx.waitUntil(sendTelegramMessage(env, chatId, `Calendar candidate saved, but Google Calendar creation failed: ${error instanceof Error ? error.message : "Unknown error"}${detailLink}`));
      }
    } else {
      const connectLink = baseUrl ? `\nConnect Google Calendar: ${baseUrl}/calendar` : "";
      ctx.waitUntil(sendTelegramMessage(env, chatId, `Calendar candidate saved:\n${calendarEntry.title}\n${display.date}\n${display.time} (${display.duration})\nGoogle Calendar is not connected.${connectLink}${detailLink}`));
    }
    return json({ ok: true });
  }
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

async function listCalendarEntries(url: URL, env: Env) {
  requireDb(env);
  await ensureCalendarSchema(env);
  const status = url.searchParams.get("status");
  const where = status && calendarStatuses.has(status as CalendarStatus) ? "WHERE calendar_entries.status=?" : "";
  const rows = await env.DB!.prepare(
    `SELECT calendar_entries.*, substr(captures.raw_text, 1, 240) AS capture_preview
     FROM calendar_entries
     LEFT JOIN captures ON captures.id=calendar_entries.capture_id
     ${where}
     ORDER BY calendar_entries.start_time ASC, calendar_entries.created_at DESC
     LIMIT 200`
  ).bind(...(where ? [status] : [])).all<CalendarEntry>();
  return json({ ok: true, calendar_entries: rows.results || [] });
}

async function getCalendarEntry(id: string, env: Env) {
  const entry = await readCalendarEntry(id, env);
  return entry ? json({ ok: true, calendar_entry: entry }) : json({ ok: false, error: "Not found" }, 404);
}

async function createCalendarFromCapture(captureId: string, env: Env) {
  const existing = await readCalendarByCapture(captureId, env);
  if (existing) return json({ ok: true, calendar_entry: existing });
  const capture = await readCapture(captureId, env);
  if (!capture) return json({ ok: false, error: "Capture not found" }, 404);
  const entry = await createCalendarEntryFromText(capture, capture.raw_text, env);
  if (!entry) return json({ ok: false, error: "Couldn't find a clear date/time" }, 422);
  return json({ ok: true, calendar_entry: entry }, 201);
}

async function createCalendarEntryFromText(capture: Capture, text: string, env: Env) {
  const parsed = parseCalendarText(text);
  if (!parsed) return null;
  await ensureCalendarSchema(env);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const entry: CalendarEntry = {
    id,
    capture_id: capture.id,
    title: parsed.title,
    description: capture.raw_text,
    location: null,
    start_time: parsed.start_time,
    end_time: parsed.end_time,
    timezone: parsed.timezone,
    all_day: parsed.all_day,
    status: "pending",
    source: capture.source,
    ics_uid: `${id}@braindump.boxospam.workers.dev`,
    created_at: now,
    updated_at: now,
    metadata_json: JSON.stringify({ parser: "lightweight-v1" })
  };
  await env.DB!.prepare(
    `INSERT INTO calendar_entries
     (id, capture_id, title, description, location, start_time, end_time, timezone, all_day, status, source, ics_uid, created_at, updated_at, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(entry.id, entry.capture_id, entry.title, entry.description, entry.location, entry.start_time, entry.end_time, entry.timezone, entry.all_day, entry.status, entry.source, entry.ics_uid, entry.created_at, entry.updated_at, entry.metadata_json).run();
  return entry;
}

async function updateCalendarEntry(id: string, request: Request, env: Env) {
  const current = await readCalendarEntry(id, env);
  if (!current) return json({ ok: false, error: "Not found" }, 404);
  const body = await safeJson(request);
  const status = calendarStatuses.has(body.status) ? body.status as CalendarStatus : current.status;
  const allDay = body.all_day === undefined ? current.all_day : body.all_day ? 1 : 0;
  const startTime = String(body.start_time ?? current.start_time).trim();
  const endTime = body.end_time === null ? null : String((body.end_time ?? current.end_time) || "").trim() || null;
  if (!startTime || (!allDay && Number.isNaN(new Date(startTime).getTime()))) throw new HttpError("Valid start_time is required", 400);
  await env.DB!.prepare(
    `UPDATE calendar_entries
     SET title=?, description=?, location=?, start_time=?, end_time=?, all_day=?, status=?, updated_at=?
     WHERE id=?`
  ).bind(
    String(body.title ?? current.title).trim() || "Untitled BrainDump Event",
    nullableText(body.description, current.description),
    nullableText(body.location, current.location),
    startTime,
    endTime,
    allDay,
    status,
    new Date().toISOString(),
    id
  ).run();
  return getCalendarEntry(id, env);
}

async function cancelCalendarEntry(id: string, env: Env) {
  const current = await readCalendarEntry(id, env);
  if (!current) return json({ ok: false, error: "Not found" }, 404);
  await env.DB!.prepare("UPDATE calendar_entries SET status='canceled', updated_at=? WHERE id=?").bind(new Date().toISOString(), id).run();
  return json({ ok: true, canceled: true });
}

async function calendarIcs(id: string, env: Env) {
  const entry = await readCalendarEntry(id, env);
  if (!entry) return json({ ok: false, error: "Not found" }, 404);
  const ics = generateIcs(entry);
  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="braindump-event.ics"'
    }
  });
}

async function googleCalendarStatus(env: Env) {
  const credentials = await readGoogleCredentials(env);
  return json({
    ok: true,
    configured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    connected: Boolean(credentials?.refresh_token || credentials?.access_token),
    scope: credentials?.scope || null
  });
}

async function googleOauthConnect(env: Env) {
  requireGoogleConfig(env);
  const state = crypto.randomUUID();
  const signature = await signOauthState(state, env);
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: googleRedirectUri(env),
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar.events",
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state
  });
  return redirectWithCookie(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, oauthStateCookie(`${state}.${signature}`, 600));
}

async function googleOauthCallback(request: Request, env: Env) {
  if (!(await isWebAuthed(request, env))) return new Response("Unauthorized", { status: 401 });
  requireGoogleConfig(env);
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) return redirectWithCookie(`/calendar?google=error&reason=${encodeURIComponent(error)}`, oauthStateCookie("", 0));
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = cookieValue(request, "bd_google_oauth");
  if (!code || !state || !cookieState || !(await validOauthState(state, cookieState, env))) {
    return new Response("Invalid or expired OAuth state", { status: 400 });
  }
  const token = await googleTokenRequest({
    client_id: env.GOOGLE_CLIENT_ID!,
    client_secret: env.GOOGLE_CLIENT_SECRET!,
    code,
    grant_type: "authorization_code",
    redirect_uri: googleRedirectUri(env)
  });
  await saveGoogleCredentials(token, env);
  return redirectWithCookie("/calendar?google=connected", oauthStateCookie("", 0));
}

async function googleOauthDisconnect(env: Env) {
  const credentials = await readGoogleCredentials(env);
  const token = credentials?.refresh_token || credentials?.access_token;
  if (token) {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    }).catch(() => undefined);
  }
  await ensureCalendarOauthSchema(env);
  await env.DB!.prepare("DELETE FROM calendar_oauth WHERE provider='google'").run();
  return json({ ok: true, connected: false });
}

async function createGoogleCalendarEvent(id: string, env: Env) {
  const entry = await readCalendarEntry(id, env);
  if (!entry) return json({ ok: false, error: "Not found" }, 404);
  const googleEvent = await insertGoogleCalendarEvent(entry, env);
  return json({ ok: true, calendar_entry: await readCalendarEntry(id, env), google_event: googleEvent });
}

async function insertGoogleCalendarEvent(entry: CalendarEntry, env: Env) {
  if (entry.status === "canceled") throw new HttpError("Canceled entries cannot be created", 409);
  if (entry.external_event_id) throw new HttpError("This entry already has a Google Calendar event", 409);
  const accessToken = await googleAccessToken(env);
  const response = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(googleEventPayload(entry))
  });
  const result = await response.json<Record<string, any>>();
  if (!response.ok) {
    await env.DB!.prepare("UPDATE calendar_entries SET status='failed', metadata_json=?, updated_at=? WHERE id=?")
      .bind(JSON.stringify({ google_error: result }), new Date().toISOString(), entry.id).run();
    throw new HttpError(result.error?.message || "Google Calendar event creation failed", response.status);
  }
  await env.DB!.prepare(
    `UPDATE calendar_entries
     SET status='created', external_calendar_id='primary', external_event_id=?, metadata_json=?, updated_at=?
     WHERE id=?`
  ).bind(result.id || null, JSON.stringify({ google_html_link: result.htmlLink || null }), new Date().toISOString(), entry.id).run();
  return { id: result.id, html_link: result.htmlLink || null };
}

function googleEventPayload(entry: CalendarEntry) {
  const event: Record<string, unknown> = {
    summary: entry.title,
    description: entry.description || "",
    location: entry.location || undefined
  };
  if (entry.all_day) {
    event.start = { date: entry.start_time.slice(0, 10) };
    event.end = { date: (entry.end_time || entry.start_time).slice(0, 10) };
  } else {
    event.start = { dateTime: entry.start_time, timeZone: entry.timezone || "America/Chicago" };
    event.end = { dateTime: entry.end_time || new Date(new Date(entry.start_time).getTime() + 30 * 60000).toISOString(), timeZone: entry.timezone || "America/Chicago" };
  }
  return event;
}

async function googleAccessToken(env: Env) {
  requireGoogleConfig(env);
  const credentials = await readGoogleCredentials(env);
  if (!credentials) throw new HttpError("Google Calendar is not connected", 409);
  const expiresAt = credentials.expires_at ? new Date(credentials.expires_at).getTime() : 0;
  if (credentials.access_token && expiresAt > Date.now() + 60000) return credentials.access_token;
  if (!credentials.refresh_token) throw new HttpError("Google Calendar must be reconnected", 409);
  const token = await googleTokenRequest({
    client_id: env.GOOGLE_CLIENT_ID!,
    client_secret: env.GOOGLE_CLIENT_SECRET!,
    refresh_token: credentials.refresh_token,
    grant_type: "refresh_token"
  });
  await saveGoogleCredentials({ ...token, refresh_token: credentials.refresh_token }, env);
  return String(token.access_token);
}

async function googleTokenRequest(values: Record<string, string>) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values)
  });
  const token = await response.json<Record<string, any>>();
  if (!response.ok || !token.access_token) throw new HttpError(token.error_description || token.error || "Google token exchange failed", 400);
  return token;
}

async function saveGoogleCredentials(token: Record<string, any>, env: Env) {
  await ensureCalendarOauthSchema(env);
  const current = await readGoogleCredentials(env);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + Number(token.expires_in || 3600) * 1000).toISOString();
  await env.DB!.prepare(
    `INSERT INTO calendar_oauth (provider, access_token, refresh_token, token_type, scope, expires_at, created_at, updated_at)
     VALUES ('google', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       access_token=excluded.access_token,
       refresh_token=excluded.refresh_token,
       token_type=excluded.token_type,
       scope=excluded.scope,
       expires_at=excluded.expires_at,
       updated_at=excluded.updated_at`
  ).bind(
    token.access_token || current?.access_token || null,
    token.refresh_token || current?.refresh_token || null,
    token.token_type || current?.token_type || "Bearer",
    token.scope || current?.scope || "https://www.googleapis.com/auth/calendar.events",
    expiresAt,
    current?.created_at || now,
    now
  ).run();
}

async function readGoogleCredentials(env: Env) {
  await ensureCalendarOauthSchema(env);
  return env.DB!.prepare("SELECT * FROM calendar_oauth WHERE provider='google'").first<{
    access_token?: string | null;
    refresh_token?: string | null;
    token_type?: string | null;
    scope?: string | null;
    expires_at?: string | null;
    created_at: string;
  }>();
}

async function ensureCalendarOauthSchema(env: Env) {
  requireDb(env);
  if (!calendarOauthSchemaPromise) {
    calendarOauthSchemaPromise = env.DB!.prepare(
      `CREATE TABLE IF NOT EXISTS calendar_oauth (
        provider TEXT PRIMARY KEY,
        access_token TEXT,
        refresh_token TEXT,
        token_type TEXT,
        scope TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    ).run().then(() => undefined).catch((error) => {
      calendarOauthSchemaPromise = null;
      throw error;
    });
  }
  await calendarOauthSchemaPromise;
}

function requireGoogleConfig(env: Env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new HttpError("Google OAuth is not configured", 503);
}

function googleRedirectUri(env: Env) {
  return `${(env.APP_BASE_URL || "https://braindump.boxospam.workers.dev").replace(/\/$/, "")}/api/auth/google/callback`;
}

async function signOauthState(state: string, env: Env) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.APP_PASSWORD || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(state));
  return base64Url(new Uint8Array(signature));
}

async function validOauthState(state: string, cookieState: string, env: Env) {
  const [cookieValue, signature] = cookieState.split(".");
  return cookieValue === state && signature === await signOauthState(state, env);
}

function base64Url(value: Uint8Array) {
  return btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get("Cookie") || "";
  return cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || "";
}

function oauthStateCookie(value: string, maxAge: number) {
  return `bd_google_oauth=${value}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/google/callback; Max-Age=${maxAge}`;
}

function redirectWithCookie(location: string, cookie: string) {
  const safeLocation = escapeHtml(location);
  const scriptLocation = JSON.stringify(location).replace(/</g, "\\u003c");
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="0;url=${safeLocation}">
  <title>Continue to Google Calendar</title>
</head>
<body style="font-family:system-ui,sans-serif;background:#000;color:#fff;padding:2rem">
  <p>Continuing to Google Calendar...</p>
  <p><a style="color:#fff" href="${safeLocation}">Continue</a></p>
  <script>window.location.replace(${scriptLocation});</script>
</body>
</html>`,
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": cookie
      }
    }
  );
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function readCalendarEntry(id: string, env: Env) {
  requireDb(env);
  await ensureCalendarSchema(env);
  return env.DB!.prepare(
    `SELECT calendar_entries.*, substr(captures.raw_text, 1, 240) AS capture_preview
     FROM calendar_entries
     LEFT JOIN captures ON captures.id=calendar_entries.capture_id
     WHERE calendar_entries.id=?`
  ).bind(id).first<CalendarEntry>();
}

async function readCalendarByCapture(captureId: string, env: Env) {
  requireDb(env);
  await ensureCalendarSchema(env);
  return env.DB!.prepare("SELECT * FROM calendar_entries WHERE capture_id=? ORDER BY created_at DESC LIMIT 1").bind(captureId).first<CalendarEntry>();
}

async function ensureCalendarSchema(env: Env) {
  requireDb(env);
  if (!calendarSchemaPromise) {
    calendarSchemaPromise = env.DB!.batch([
      env.DB!.prepare(
        `CREATE TABLE IF NOT EXISTS calendar_entries (
          id TEXT PRIMARY KEY,
          capture_id TEXT,
          title TEXT NOT NULL,
          description TEXT,
          location TEXT,
          start_time TEXT NOT NULL,
          end_time TEXT,
          timezone TEXT DEFAULT 'America/Chicago',
          all_day INTEGER DEFAULT 0,
          status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'exported', 'created', 'canceled', 'failed')),
          source TEXT DEFAULT 'telegram',
          external_calendar_id TEXT,
          external_event_id TEXT,
          ics_uid TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          metadata_json TEXT
        )`
      ),
      env.DB!.prepare("CREATE INDEX IF NOT EXISTS idx_calendar_entries_capture_id ON calendar_entries(capture_id)"),
      env.DB!.prepare("CREATE INDEX IF NOT EXISTS idx_calendar_entries_status ON calendar_entries(status)"),
      env.DB!.prepare("CREATE INDEX IF NOT EXISTS idx_calendar_entries_start_time ON calendar_entries(start_time)")
    ]).then(() => undefined).catch((error) => {
      calendarSchemaPromise = null;
      throw error;
    });
  }
  await calendarSchemaPromise;
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

async function withTags(captures: Capture[], env: Env) {
  if (!captures.length) return captures;
  const placeholders = captures.map(() => "?").join(",");
  const rows = await env.DB!.prepare(
    `SELECT capture_tags.capture_id, tags.name
     FROM capture_tags
     JOIN tags ON tags.id=capture_tags.tag_id
     WHERE capture_tags.capture_id IN (${placeholders})
     ORDER BY tags.name`
  ).bind(...captures.map((capture) => capture.id)).all<{ capture_id: string; name: string }>();
  const byCapture = new Map<string, string[]>();
  for (const row of rows.results || []) {
    const list = byCapture.get(row.capture_id) || [];
    list.push(row.name);
    byCapture.set(row.capture_id, list);
  }
  return captures.map((capture) => ({ ...capture, tags: byCapture.get(capture.id) || [] }));
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
  return clean;
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

function sanitizeTag(value: unknown) {
  const tag = String(value || "").trim().replace(/^#/, "").toLowerCase();
  return tag || null;
}

function nullableText(value: unknown, fallback?: string | null) {
  if (value === undefined) return fallback || null;
  const text = String(value || "").trim();
  return text || null;
}

function tagsFromText(text: string) {
  return [...text.matchAll(/(^|\s)#([a-z0-9][a-z0-9_-]{0,48})/gi)].map((match) => match[2].toLowerCase());
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
