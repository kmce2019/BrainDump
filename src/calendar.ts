export const CALENDAR_TIMEZONE = "America/Chicago";

export type CalendarParseResult = {
  title: string;
  start_time: string;
  end_time: string;
  timezone: string;
  all_day: number;
};

type DateParts = { year: number; month: number; day: number };
type TimeParts = { hour: number; minute: number };

const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const months: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};

export function parseCalendarText(input: string, now = new Date()): CalendarParseResult | null {
  const text = input.replace(/^\/(?:cal|calendar|schedule|event)(?:@\w+)?\s*/i, "").trim();
  if (!text) return null;

  const localToday = chicagoDateParts(now);
  const dateMatch = findDate(text, localToday);
  if (!dateMatch) return null;

  const timeMatch = findTime(text);
  const allDay = timeMatch ? 0 : 1;
  const startTime = timeMatch
    ? chicagoLocalToIso(dateMatch.date, timeMatch.start)
    : formatDate(dateMatch.date);
  const endDate = timeMatch
    ? addMinutesToChicago(dateMatch.date, timeMatch.start, timeMatch.durationMinutes)
    : formatDate(addDays(dateMatch.date, 1));
  const ranges = [dateMatch.range, timeMatch?.range].filter(Boolean) as Array<[number, number]>;
  const title = removeRanges(text, ranges) || "Untitled BrainDump Event";

  return {
    title,
    start_time: startTime,
    end_time: endDate,
    timezone: CALENDAR_TIMEZONE,
    all_day: allDay
  };
}

export function formatCalendarDateTime(entry: {
  start_time: string;
  end_time?: string | null;
  all_day: number;
  timezone?: string | null;
}) {
  if (entry.all_day) {
    const date = parseDateOnly(entry.start_time);
    return {
      date: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(date),
      time: "All day",
      duration: "All day"
    };
  }
  const timezone = entry.timezone || CALENDAR_TIMEZONE;
  const start = new Date(entry.start_time);
  const end = entry.end_time ? new Date(entry.end_time) : new Date(start.getTime() + 30 * 60000);
  return {
    date: new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(start),
    time: `${new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(start)}-${new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(end)}`,
    duration: formatDuration(Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000)))
  };
}

export function generateIcs(entry: {
  ics_uid: string;
  title: string;
  description?: string | null;
  location?: string | null;
  start_time: string;
  end_time?: string | null;
  all_day: number;
  created_at: string;
}) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//BrainDump//Calendar Export//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${escapeIcs(entry.ics_uid)}`,
    `DTSTAMP:${icsUtc(new Date())}`
  ];
  if (entry.all_day) {
    const start = entry.start_time.slice(0, 10).replace(/-/g, "");
    const end = (entry.end_time || formatDate(addDays(dateParts(entry.start_time), 1))).slice(0, 10).replace(/-/g, "");
    lines.push(`DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${end}`);
  } else {
    const start = new Date(entry.start_time);
    const end = entry.end_time ? new Date(entry.end_time) : new Date(start.getTime() + 30 * 60000);
    lines.push(`DTSTART:${icsUtc(start)}`, `DTEND:${icsUtc(end)}`);
  }
  lines.push(`SUMMARY:${escapeIcs(entry.title)}`);
  lines.push(`DESCRIPTION:${escapeIcs(entry.description || "")}`);
  if (entry.location) lines.push(`LOCATION:${escapeIcs(entry.location)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.flatMap(foldIcsLine).join("\r\n") + "\r\n";
}

function findDate(text: string, today: DateParts): { date: DateParts; range: [number, number] } | null {
  const patterns: Array<(text: string) => { date: DateParts; range: [number, number] } | null> = [
    (value) => {
      const match = /\b(today|tomorrow)\b/i.exec(value);
      if (!match) return null;
      return { date: addDays(today, match[1].toLowerCase() === "tomorrow" ? 1 : 0), range: [match.index, match.index + match[0].length] };
    },
    (value) => {
      const match = /\b(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.exec(value);
      if (!match) return null;
      const target = weekdays.indexOf(match[2].toLowerCase());
      const current = weekday(today);
      let days = (target - current + 7) % 7;
      if (match[1] || days === 0) days += 7;
      return { date: addDays(today, days), range: [match.index, match.index + match[0].length] };
    },
    (value) => {
      const match = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+([0-3]?\d)(?:,\s*(\d{4}))?\b/i.exec(value);
      if (!match) return null;
      const month = months[match[1].toLowerCase()];
      const day = Number(match[2]);
      const year = match[3] ? Number(match[3]) : inferredYear(today, month, day);
      if (!validDate(year, month, day)) return null;
      return { date: { year, month, day }, range: [match.index, match.index + match[0].length] };
    },
    (value) => {
      const match = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(value);
      if (!match) return null;
      const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
      return validDate(date.year, date.month, date.day) ? { date, range: [match.index, match.index + match[0].length] } : null;
    },
    (value) => {
      const match = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(value);
      if (!match) return null;
      const month = Number(match[1]);
      const day = Number(match[2]);
      const rawYear = match[3] ? Number(match[3]) : null;
      const year = rawYear ? (rawYear < 100 ? 2000 + rawYear : rawYear) : inferredYear(today, month, day);
      return validDate(year, month, day) ? { date: { year, month, day }, range: [match.index, match.index + match[0].length] } : null;
    }
  ];
  for (const pattern of patterns) {
    const result = pattern(text);
    if (result) return result;
  }
  return null;
}

function findTime(text: string): { start: TimeParts; durationMinutes: number; range: [number, number] } | null {
  const pattern = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?\b/gi;
  for (const match of text.matchAll(pattern)) {
    const hasColon = match[2] !== undefined;
    const hasMeridiem = Boolean(match[3]);
    if (!hasColon && !hasMeridiem) continue;
    const endMeridiem = match[6]?.toLowerCase();
    const startMeridiem = match[3]?.toLowerCase() || endMeridiem;
    const start = normalizeTime(Number(match[1]), Number(match[2] || 0), startMeridiem);
    if (!start) continue;
    let durationMinutes = 30;
    if (match[4]) {
      const end = normalizeTime(Number(match[4]), Number(match[5] || 0), endMeridiem || startMeridiem);
      if (!end) continue;
      durationMinutes = end.hour * 60 + end.minute - (start.hour * 60 + start.minute);
      if (durationMinutes <= 0) durationMinutes += 24 * 60;
    }
    return { start, durationMinutes, range: [match.index!, match.index! + match[0].length] };
  }
  return null;
}

function normalizeTime(hour: number, minute: number, meridiem?: string): TimeParts | null {
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12 + (meridiem === "pm" ? 12 : 0);
  } else if (hour > 23) return null;
  return { hour, minute };
}

function chicagoDateParts(date: Date): DateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CALENDAR_TIMEZONE, year: "numeric", month: "numeric", day: "numeric"
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function chicagoLocalToIso(date: DateParts, time: TimeParts) {
  const desiredUtc = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  let candidate = desiredUtc;
  for (let i = 0; i < 3; i++) {
    const parts = zonedParts(new Date(candidate));
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    candidate += desiredUtc - represented;
  }
  return new Date(candidate).toISOString();
}

function zonedParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CALENDAR_TIMEZONE, year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", hourCycle: "h23"
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
}

function addMinutesToChicago(date: DateParts, time: TimeParts, minutes: number) {
  const local = new Date(Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute + minutes));
  return chicagoLocalToIso(
    { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate() },
    { hour: local.getUTCHours(), minute: local.getUTCMinutes() }
  );
}

function removeRanges(text: string, ranges: Array<[number, number]>) {
  const chars = [...text];
  for (const [start, end] of ranges) {
    for (let i = start; i < end; i++) chars[i] = " ";
  }
  return chars.join("")
    .replace(/\s+/g, " ")
    .replace(/\b(?:at|on)\s+(?=for\b|$)/gi, "")
    .replace(/^[\s,;:-]+|[\s,;:-]+$/g, "")
    .trim();
}

function inferredYear(today: DateParts, month: number, day: number) {
  return month < today.month || (month === today.month && day < today.day) ? today.year + 1 : today.year;
}

function validDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function weekday(date: DateParts) {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function addDays(date: DateParts, days: number): DateParts {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function dateParts(value: string): DateParts {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return { year, month, day };
}

function formatDate(date: DateParts) {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function parseDateOnly(value: string) {
  const parts = dateParts(value);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
}

function icsUtc(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function escapeIcs(value: string) {
  return String(value).replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function foldIcsLine(line: string) {
  const chunks: string[] = [];
  let rest = line;
  while (new TextEncoder().encode(rest).length > 75) {
    let end = Math.min(73, rest.length);
    while (new TextEncoder().encode(rest.slice(0, end)).length > 73) end--;
    chunks.push(rest.slice(0, end));
    rest = ` ${rest.slice(end)}`;
  }
  chunks.push(rest);
  return chunks;
}
