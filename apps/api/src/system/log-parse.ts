/**
 * Turns the log lines the services report into entries the admin panel can
 * show as a table: when, which process, how serious, and the message. Each
 * service writes its own format; anything unrecognised is kept whole, with
 * no time, as an "info" line.
 */

export type LogLevel = 'error' | 'warning' | 'info' | 'debug';

export interface LogEntry {
  /** ISO 8601, or null when the line carries no time we understand. */
  time: string | null;
  level: LogLevel;
  /** The process or component (postfix/smtpd, imaps, rspamd_proxy, a Nest context…). */
  source: string | null;
  message: string;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const LEVEL_WORDS: Record<string, LogLevel> = {
  emerg: 'error',
  alert: 'error',
  crit: 'error',
  critical: 'error',
  fatal: 'error',
  panic: 'error',
  error: 'error',
  err: 'error',
  warning: 'warning',
  warn: 'warning',
  notice: 'info',
  info: 'info',
  log: 'info',
  debug: 'debug',
  verbose: 'debug',
  trace: 'debug',
};

function levelOf(word: string | undefined): LogLevel | undefined {
  return word ? LEVEL_WORDS[word.toLowerCase()] : undefined;
}

/** A level from the message itself: "warning: …", "error: …", or words that mean trouble. */
function guessLevel(message: string): LogLevel {
  const prefix = /^(?:\[)?(emerg|alert|crit(?:ical)?|fatal|panic|error|err|warning|warn|notice|info|debug)\b[\]:]?/i.exec(message);
  const fromPrefix = levelOf(prefix?.[1]);
  if (fromPrefix) return fromPrefix;
  if (/\b(fatal|panic|segfault|out of memory|cannot|can't|unable to|exception)\b/i.test(message)) return 'error';
  if (/\b(error|errors)\b/i.test(message) && !/\berrors?=0\b/i.test(message)) return 'error';
  if (/\b(reject|rejected|refused|warning|timeout|timed out|failed|failure|denied|lost connection|blocked|deferred|bounced)\b/i.test(message)) {
    return 'warning';
  }
  return 'info';
}

/** "Nov  3 09:10:57" → an ISO time in `now`'s year (the year before if that would be in the future). */
function syslogTime(month: string, day: string, time: string, now: Date): string | null {
  const m = MONTHS.indexOf(month.toLowerCase());
  if (m < 0) return null;
  const [h, min, s] = time.split(':').map(Number);
  let date = new Date(Date.UTC(now.getUTCFullYear(), m, Number(day), h, min, s));
  if (date.getTime() - now.getTime() > 2 * 86_400_000) date = new Date(Date.UTC(now.getUTCFullYear() - 1, m, Number(day), h, min, s));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isoTime(value: string): string | null {
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** logfmt pairs: key=value or key="quoted value". */
function logfmt(line: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  const re = /(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g;
  let match: RegExpExecArray | null;
  let found = 0;
  while ((match = re.exec(line))) {
    const raw = match[2]!;
    out[match[1]!] = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw;
    found++;
  }
  return found >= 2 && ('msg' in out || 'level' in out) ? out : null;
}

export function parseLogLine(line: string, now = new Date()): LogEntry {
  let match: RegExpExecArray | null;

  // JSON lines (the API with LOG_FORMAT=json, and others).
  if (line.startsWith('{')) {
    try {
      const json = JSON.parse(line) as Record<string, unknown>;
      const message = String(json.message ?? json.msg ?? line);
      const time = typeof json.timestamp === 'number' ? new Date(json.timestamp).toISOString() : typeof json.time === 'string' ? isoTime(json.time) : null;
      return {
        time,
        level: levelOf(String(json.level ?? '')) ?? guessLevel(message),
        source: typeof json.context === 'string' ? json.context : null,
        message,
      };
    } catch {
      // Not JSON after all.
    }
  }

  // Nest: "[Nest] 1  - 11/03/2026, 1:16:51 PM     LOG [Context] message"
  if ((match = /^\[Nest\]\s+\d+\s+-\s+(.+?)\s+(LOG|ERROR|WARN|DEBUG|VERBOSE|FATAL)\s+\[([^\]]+)\]\s?(.*)$/.exec(line))) {
    const date = new Date(match[1]!.replace(',', ''));
    return {
      time: Number.isNaN(date.getTime()) ? null : date.toISOString(),
      level: levelOf(match[2]) ?? 'info',
      source: match[3]!,
      message: match[4]!,
    };
  }

  // Syslog: "Nov 03 09:10:57 mail postfix/smtpd[14960]: message"
  if ((match = /^([A-Z][a-z]{2})\s+(\d{1,2}) (\d\d:\d\d:\d\d)\s+(\S+)\s+([^\s:[]+)(?:\[\d+\])?:\s?(.*)$/.exec(line))) {
    const message = match[6]!;
    return { time: syslogTime(match[1]!, match[2]!, match[3]!, now), level: guessLevel(message), source: match[5]!, message };
  }

  // RFC 5424-ish / ISO syslog: "2026-11-03T12:00:00.123+00:00 host process[1]: message"
  if ((match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?)\s+(\S+)\s+([^\s:[]+)(?:\[\d+\])?:\s?(.*)$/.exec(line))) {
    const message = match[4]!;
    return { time: isoTime(match[1]!), level: guessLevel(message), source: match[3]!, message };
  }

  // Rspamd: "2026-11-03 12:25:03 #41(rspamd_proxy) <33c412>; proxy; message"
  if ((match = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)(?:[.,]\d+)? #\d+\(([^)]+)\)\s*(?:<[0-9a-f]*>;\s*)?(?:([\w.-]+);\s*)?(.*)$/.exec(line))) {
    const message = match[4]!;
    return { time: isoTime(match[1]!), level: guessLevel(message), source: match[3] ? `${match[2]}/${match[3]}` : match[2]!, message };
  }

  // Unbound: "[1730647000] unbound[1:0] info: message"
  if ((match = /^\[(\d{9,})\] (\S+?)\[[\d:]+\] (\w+): (.*)$/.exec(line))) {
    return {
      time: new Date(Number(match[1]) * 1000).toISOString(),
      level: levelOf(match[3]) ?? guessLevel(match[4]!),
      source: match[2]!,
      message: match[4]!,
    };
  }

  // Go's log (lego, the certificates): "2026/11/03 12:00:00 [INFO] message"
  if ((match = /^(\d{4})\/(\d\d)\/(\d\d) (\d\d:\d\d:\d\d) (?:\[(\w+)\] )?(.*)$/.exec(line))) {
    const message = match[6]!;
    return { time: isoTime(`${match[1]}-${match[2]}-${match[3]} ${match[4]}`), level: levelOf(match[5]) ?? guessLevel(message), source: null, message };
  }

  // ClamAV: "Mon Nov  3 12:00:00 2026 -> message"
  if ((match = /^[A-Z][a-z]{2} ([A-Z][a-z]{2})\s+(\d{1,2}) (\d\d:\d\d:\d\d) (\d{4}) -> (.*)$/.exec(line))) {
    const time = syslogTime(match[1]!, match[2]!, match[3]!, new Date(Date.UTC(Number(match[4]), 11, 31)));
    return { time, level: guessLevel(match[5]!), source: null, message: match[5]! };
  }

  // logfmt (CrowdSec): time="…" level=info msg="…"
  const fields = logfmt(line);
  if (fields) {
    const message = fields.msg ?? line;
    return {
      time: fields.time ? isoTime(fields.time) : null,
      level: levelOf(fields.level) ?? guessLevel(message),
      source: fields.type ?? fields.module ?? fields.name ?? null,
      message,
    };
  }

  // "2026-11-03 12:00:00 message" and the rest.
  if ((match = /^(\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d)(?:[.,]\d+)?\s+(.*)$/.exec(line))) {
    return { time: isoTime(match[1]!), level: guessLevel(match[2]!), source: null, message: match[2]! };
  }
  return { time: null, level: guessLevel(line), source: null, message: line };
}
