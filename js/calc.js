/**
 * Pure time/pay math. No DOM, no storage — safe to unit test in node.
 *
 * Conventions used throughout:
 *  - Instants are epoch milliseconds.
 *  - "Day" and "week" boundaries are *local* to the device, because a shift
 *    that starts at 23:00 belongs to the day the worker calls it.
 *  - Rounding is applied to the shift *duration* (not to the clock times), so
 *    what you bill is always exactly what the rounding rule says.
 */

export const MINUTE = 60_000;
export const HOUR = 3_600_000;

/* ------------------------------------------------------------------ *
 * Rounding
 * ------------------------------------------------------------------ */

/** @typedef {{mode:'none'|'nearest'|'up'|'down', increment:number}} Rounding */

export const DEFAULT_ROUNDING = { mode: 'none', increment: 15 };

/**
 * Round a duration to a multiple of `increment` minutes.
 * @param {number} ms
 * @param {Rounding} [rounding]
 */
export function applyRounding(ms, rounding) {
  const r = rounding || DEFAULT_ROUNDING;
  if (!r.mode || r.mode === 'none') return ms;
  const inc = (Number(r.increment) || 0) * MINUTE;
  if (inc <= 0) return ms;
  const q = ms / inc;
  const n = r.mode === 'up' ? Math.ceil(q) : r.mode === 'down' ? Math.floor(q) : Math.round(q);
  return n * inc;
}

/* ------------------------------------------------------------------ *
 * Entry metrics
 * ------------------------------------------------------------------ */

/**
 * Break minutes owed for an entry. A manually entered break always wins; the
 * job's automatic break only fills in when the user did not record one.
 */
export function breakMinutesFor(entry, job, roundedMs) {
  const manual = Number(entry.breakMinutes) || 0;
  if (manual > 0) return manual;
  const ab = job && job.autoBreak;
  if (!ab || !ab.enabled) return 0;
  if (roundedMs >= (Number(ab.afterHours) || 0) * HOUR) return Number(ab.deductMinutes) || 0;
  return 0;
}

/**
 * Everything derived from a single entry.
 * @param {object} entry  {start, end|null, breakMinutes}
 * @param {object} [job]
 * @param {number} [now]  clock used for a still-running entry
 */
export function entryMetrics(entry, job, now = Date.now()) {
  const start = toMs(entry.start);
  const running = !entry.end;
  const end = running ? now : toMs(entry.end);
  const elapsed = Math.max(0, end - start);
  const rounded = applyRounding(elapsed, job && job.rounding);
  const breakMinutes = breakMinutesFor(entry, job, rounded);
  const worked = Math.max(0, rounded - breakMinutes * MINUTE);
  return {
    start,
    end,
    running,
    elapsed,
    rounded,
    breakMinutes,
    worked,
    hours: worked / HOUR,
  };
}

function toMs(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  return new Date(v).getTime();
}

/* ------------------------------------------------------------------ *
 * Local day / week keys
 * ------------------------------------------------------------------ */

/** Local calendar day as `YYYY-MM-DD`. */
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function pad(n) {
  return String(n).padStart(2, '0');
}

/** Midnight at the start of the local day containing `ms`. */
export function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(ms, n) {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Midnight at the start of the week containing `ms`. `weekStart`: 0=Sun. */
export function startOfWeek(ms, weekStart = 0) {
  const d = new Date(startOfDay(ms));
  const shift = (d.getDay() - weekStart + 7) % 7;
  return addDays(d.getTime(), -shift);
}

export function weekKey(ms, weekStart = 0) {
  return dayKey(startOfWeek(ms, weekStart));
}

/* ------------------------------------------------------------------ *
 * Overtime
 * ------------------------------------------------------------------ */

export const DEFAULT_OVERTIME = {
  enabled: false,
  dailyAfter: 8,
  weeklyAfter: 40,
  multiplier: 1.5,
};

/**
 * Split a set of entries into regular and overtime hours for one job.
 *
 * Daily overtime is counted first; weekly overtime then only counts the hours a
 * week exceeds its threshold by *beyond* what was already paid as daily OT, so
 * an hour is never counted twice.
 *
 * @param {Array<{dayMs:number, hours:number}>} worked
 * @param {object} overtime
 * @param {number} weekStart
 */
export function splitOvertime(worked, overtime, weekStart = 0) {
  const total = worked.reduce((s, w) => s + w.hours, 0);
  const ot = overtime || DEFAULT_OVERTIME;
  if (!ot.enabled) return { regular: total, overtime: 0, total };

  const byDay = new Map();
  const byWeek = new Map();
  for (const w of worked) {
    const dk = dayKey(w.dayMs);
    const wk = weekKey(w.dayMs, weekStart);
    byDay.set(dk, (byDay.get(dk) || 0) + w.hours);
    if (!byWeek.has(wk)) byWeek.set(wk, { hours: 0, days: new Set() });
    const bucket = byWeek.get(wk);
    bucket.hours += w.hours;
    bucket.days.add(dk);
  }

  const dailyAfter = Number(ot.dailyAfter) || 0;
  const dailyOtByDay = new Map();
  for (const [dk, hours] of byDay) {
    dailyOtByDay.set(dk, dailyAfter > 0 ? Math.max(0, hours - dailyAfter) : 0);
  }

  const weeklyAfter = Number(ot.weeklyAfter) || 0;
  let otHours = 0;
  for (const [, bucket] of byWeek) {
    let dailyOtThisWeek = 0;
    for (const dk of bucket.days) dailyOtThisWeek += dailyOtByDay.get(dk) || 0;
    const weeklyOt = weeklyAfter > 0 ? Math.max(0, bucket.hours - weeklyAfter) : 0;
    otHours += Math.max(dailyOtThisWeek, weeklyOt);
  }

  otHours = Math.min(otHours, total);
  return { regular: total - otHours, overtime: otHours, total };
}

/* ------------------------------------------------------------------ *
 * Summaries
 * ------------------------------------------------------------------ */

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Hours as they are actually billed: hundredths of an hour. Everything that
 * shows money — the app's totals and the generated invoice alike — starts here,
 * so the figure on screen is the figure the client is charged.
 */
export function billableHours(hours) {
  return round2(hours);
}

/** The amount for a stretch of time, computed from the hours as printed. */
export function amountFor(hours, rate) {
  return round2(billableHours(hours) * (Number(rate) || 0));
}

/**
 * Aggregate entries into a billable summary, grouped per job.
 *
 * Overtime is expressed as a *premium* (the extra above the base rate) so that
 * every line item can be shown at the plain hourly rate and still add up.
 *
 * @param {Array} entries
 * @param {Map|object} jobsById
 * @param {{weekStart?:number, now?:number}} [opts]
 */
export function summarize(entries, jobsById, opts = {}) {
  const weekStart = opts.weekStart || 0;
  const now = opts.now || Date.now();
  const get = (id) => (jobsById instanceof Map ? jobsById.get(id) : jobsById[id]);

  const groups = new Map();
  for (const entry of entries) {
    const job = get(entry.jobId);
    const m = entryMetrics(entry, job, now);
    if (!groups.has(entry.jobId)) {
      groups.set(entry.jobId, { job, jobId: entry.jobId, entries: [], worked: [], hours: 0 });
    }
    const g = groups.get(entry.jobId);
    const hours = billableHours(m.hours);
    g.entries.push({ entry, metrics: m, hours });
    g.worked.push({ dayMs: m.start, hours });
    g.hours += hours;
  }

  const jobs = [];
  let totalHours = 0;
  let totalPay = 0;
  let totalOvertimeHours = 0;

  for (const g of groups.values()) {
    const rate = Number(g.job && g.job.rate) || 0;
    const ot = (g.job && g.job.overtime) || DEFAULT_OVERTIME;
    const split = splitOvertime(g.worked, ot, weekStart);
    const multiplier = Number(ot.multiplier) || 1.5;
    // Sum the per-entry amounts rather than multiplying the total hours, so the
    // figure here is exactly the sum of the rows on screen and of the lines on
    // a per-shift invoice. (Grouping an invoice by day or job can still land a
    // cent away — that is ordinary invoice rounding, and each document always
    // adds up against itself.)
    const basePay = round2(g.entries.reduce((sum, e) => sum + amountFor(e.hours, rate), 0));
    const premium = round2(split.overtime * rate * (multiplier - 1));
    const pay = round2(basePay + premium);

    jobs.push({
      jobId: g.jobId,
      job: g.job,
      entries: g.entries,
      rate,
      hours: split.total,
      regularHours: split.regular,
      overtimeHours: split.overtime,
      overtimeMultiplier: multiplier,
      basePay,
      overtimePremium: premium,
      pay,
    });

    totalHours = round2(totalHours + split.total);
    totalOvertimeHours = round2(totalOvertimeHours + split.overtime);
    totalPay = round2(totalPay + pay);
  }

  jobs.sort((a, b) => (a.job?.name || '').localeCompare(b.job?.name || ''));

  return {
    jobs,
    entryCount: entries.length,
    hours: totalHours,
    overtimeHours: totalOvertimeHours,
    pay: totalPay,
  };
}

/* ------------------------------------------------------------------ *
 * Pay periods
 * ------------------------------------------------------------------ */

/** @typedef {{type:'weekly'|'biweekly'|'semimonthly'|'monthly', anchor?:string, weekStart?:number}} PayPeriodConfig */

export const DEFAULT_PAY_PERIOD = { type: 'biweekly', anchor: null, weekStart: 0 };

/**
 * The pay period containing `ms`, as a half-open range `[start, end)`.
 * @param {number} ms
 * @param {PayPeriodConfig} config
 */
export function payPeriodFor(ms, config = DEFAULT_PAY_PERIOD) {
  const weekStart = config.weekStart || 0;
  const day = startOfDay(ms);

  switch (config.type) {
    case 'weekly': {
      const start = startOfWeek(day, weekStart);
      return { start, end: addDays(start, 7) };
    }
    case 'semimonthly': {
      const d = new Date(day);
      const firstHalf = d.getDate() <= 15;
      const start = new Date(d.getFullYear(), d.getMonth(), firstHalf ? 1 : 16).getTime();
      const end = firstHalf
        ? new Date(d.getFullYear(), d.getMonth(), 16).getTime()
        : new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
      return { start, end };
    }
    case 'monthly': {
      const d = new Date(day);
      return {
        start: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
        end: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(),
      };
    }
    case 'biweekly':
    default: {
      // With no anchor configured, fall back to a fixed reference week rather
      // than the date being asked about — otherwise every query defines its own
      // grid and consecutive "periods" overlap each other.
      const anchor = config.anchor
        ? startOfWeek(toMs(config.anchor), weekStart)
        : startOfWeek(0, weekStart);
      const week = startOfWeek(day, weekStart);
      // Count whole weeks from the anchor using calendar days, so DST shifts
      // never knock the period off by one.
      const weeksApart = Math.round((week - anchor) / (7 * 24 * HOUR));
      const periodsApart = Math.floor(weeksApart / 2);
      const start = addDays(anchor, periodsApart * 14);
      return { start, end: addDays(start, 14) };
    }
  }
}

/** The `count` most recent pay periods, newest first. */
export function recentPayPeriods(count, config = DEFAULT_PAY_PERIOD, now = Date.now()) {
  const out = [];
  let cursor = now;
  for (let i = 0; i < count; i++) {
    const period = payPeriodFor(cursor, config);
    out.push(period);
    cursor = period.start - 1;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Formatting helpers (pure, shared by UI and exports)
 * ------------------------------------------------------------------ */

/** `1:06` — hours and minutes, the way a timesheet reads. */
export function formatDuration(ms) {
  const totalMinutes = Math.floor(Math.max(0, ms) / MINUTE);
  return `${Math.floor(totalMinutes / 60)}:${pad(totalMinutes % 60)}`;
}

/** `1:06:09` — used for the live ticking timer only. */
export function formatStopwatch(ms) {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(totalSeconds / 3600);
  return `${h}:${pad(Math.floor((totalSeconds % 3600) / 60))}:${pad(totalSeconds % 60)}`;
}

/** `1.1h` — decimal hours, which is what invoices bill in. */
export function formatHours(hours, digits = 2) {
  return `${round(hours, digits)}h`;
}

export function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round((n + Number.EPSILON) * f) / f;
}

export function formatMoney(amount, currency = 'USD', locale = undefined) {
  try {
    // An empty locale string is not a valid tag — it has to become undefined
    // so Intl falls back to the device locale instead of throwing.
    return new Intl.NumberFormat(locale || undefined, { style: 'currency', currency })
      .format(amount || 0);
  } catch {
    return `${currency} ${round(amount || 0, 2).toFixed(2)}`;
  }
}

/** Overlap test used to stop two shifts from claiming the same minutes. */
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}
