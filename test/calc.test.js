import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyRounding,
  entryMetrics,
  breakMinutesFor,
  splitOvertime,
  summarize,
  payPeriodFor,
  recentPayPeriods,
  startOfWeek,
  dayKey,
  formatDuration,
  formatHours,
  overlaps,
  round2,
  MINUTE,
  HOUR,
} from '../js/calc.js';

import { toCSV, entriesCSV, buildLineItems, buildDocument, escapeHtml, mailtoLink } from '../js/export.js';

/** A local wall-clock time, so tests don't depend on the runner's zone. */
const at = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm).getTime();

/* ------------------------------------------------------------------ *
 * Rounding
 * ------------------------------------------------------------------ */

test('no rounding leaves a duration untouched', () => {
  assert.equal(applyRounding(67 * MINUTE, { mode: 'none', increment: 15 }), 67 * MINUTE);
  assert.equal(applyRounding(67 * MINUTE, undefined), 67 * MINUTE);
});

test('rounds to the nearest increment in both directions', () => {
  const r = { mode: 'nearest', increment: 15 };
  assert.equal(applyRounding(67 * MINUTE, r), 60 * MINUTE);
  assert.equal(applyRounding(68 * MINUTE, r), 75 * MINUTE);
  assert.equal(applyRounding(0, r), 0);
});

test('always-up and always-down respect the increment', () => {
  assert.equal(applyRounding(61 * MINUTE, { mode: 'up', increment: 15 }), 75 * MINUTE);
  assert.equal(applyRounding(74 * MINUTE, { mode: 'down', increment: 15 }), 60 * MINUTE);
  assert.equal(applyRounding(60 * MINUTE, { mode: 'up', increment: 15 }), 60 * MINUTE);
});

test('a zero or missing increment is ignored rather than dividing by zero', () => {
  assert.equal(applyRounding(67 * MINUTE, { mode: 'up', increment: 0 }), 67 * MINUTE);
});

/* ------------------------------------------------------------------ *
 * Entry metrics
 * ------------------------------------------------------------------ */

test('a plain entry reports its worked time and decimal hours', () => {
  const m = entryMetrics({ start: at(2026, 3, 2, 9), end: at(2026, 3, 2, 12, 30) }, null);
  assert.equal(m.worked, 3.5 * HOUR);
  assert.equal(m.hours, 3.5);
  assert.equal(m.running, false);
});

test('a manual break is deducted from the worked time', () => {
  const m = entryMetrics({ start: at(2026, 3, 2, 9), end: at(2026, 3, 2, 12), breakMinutes: 30 }, null);
  assert.equal(m.hours, 2.5);
});

test('a running entry measures against the supplied clock', () => {
  const start = at(2026, 3, 2, 9);
  const m = entryMetrics({ start, end: null }, null, start + 90 * MINUTE);
  assert.equal(m.running, true);
  assert.equal(m.hours, 1.5);
});

test('an end before the start yields zero rather than negative time', () => {
  const m = entryMetrics({ start: at(2026, 3, 2, 12), end: at(2026, 3, 2, 9) }, null);
  assert.equal(m.worked, 0);
});

test('a break longer than the shift cannot make pay negative', () => {
  const m = entryMetrics({ start: at(2026, 3, 2, 9), end: at(2026, 3, 2, 10), breakMinutes: 180 }, null);
  assert.equal(m.worked, 0);
});

test('the automatic break applies only past its threshold', () => {
  const job = { autoBreak: { enabled: true, afterHours: 6, deductMinutes: 30 } };
  assert.equal(breakMinutesFor({ breakMinutes: 0 }, job, 5 * HOUR), 0);
  assert.equal(breakMinutesFor({ breakMinutes: 0 }, job, 7 * HOUR), 30);
});

test('a recorded break wins over the automatic one', () => {
  const job = { autoBreak: { enabled: true, afterHours: 6, deductMinutes: 30 } };
  assert.equal(breakMinutesFor({ breakMinutes: 45 }, job, 8 * HOUR), 45);
});

test('rounding is applied before the break is deducted', () => {
  const job = { rounding: { mode: 'up', increment: 30 } };
  // 1h50m rounds up to 2h, then 20 minutes of break comes off.
  const m = entryMetrics(
    { start: at(2026, 3, 2, 9), end: at(2026, 3, 2, 10, 50), breakMinutes: 20 },
    job
  );
  assert.equal(m.rounded, 2 * HOUR);
  assert.equal(m.worked, 100 * MINUTE);
});

/* ------------------------------------------------------------------ *
 * Overtime
 * ------------------------------------------------------------------ */

test('overtime is zero when the rule is switched off', () => {
  const worked = [{ dayMs: at(2026, 3, 2, 9), hours: 12 }];
  assert.deepEqual(splitOvertime(worked, { enabled: false }), { regular: 12, overtime: 0, total: 12 });
});

test('daily overtime counts only the hours past the daily threshold', () => {
  const worked = [{ dayMs: at(2026, 3, 2, 9), hours: 10 }];
  const split = splitOvertime(worked, { enabled: true, dailyAfter: 8, weeklyAfter: 40, multiplier: 1.5 });
  assert.equal(split.overtime, 2);
  assert.equal(split.regular, 8);
});

test('weekly overtime applies when no single day crosses the daily line', () => {
  // Mon–Sat, 7.5h each = 45h. No day exceeds 8, but the week exceeds 40.
  const worked = [2, 3, 4, 5, 6, 7].map((d) => ({ dayMs: at(2026, 3, d, 9), hours: 7.5 }));
  const split = splitOvertime(worked, { enabled: true, dailyAfter: 8, weeklyAfter: 40, multiplier: 1.5 }, 0);
  assert.equal(split.total, 45);
  assert.equal(split.overtime, 5);
});

test('an hour is never counted as both daily and weekly overtime', () => {
  // Five 10-hour days: 50h total, 10h of daily OT, and 10h over the weekly line.
  const worked = [2, 3, 4, 5, 6].map((d) => ({ dayMs: at(2026, 3, d, 9), hours: 10 }));
  const split = splitOvertime(worked, { enabled: true, dailyAfter: 8, weeklyAfter: 40, multiplier: 1.5 }, 0);
  assert.equal(split.total, 50);
  assert.equal(split.overtime, 10);
  assert.equal(split.regular, 40);
});

test('overtime can never exceed the hours actually worked', () => {
  const worked = [{ dayMs: at(2026, 3, 2, 9), hours: 4 }];
  const split = splitOvertime(worked, { enabled: true, dailyAfter: 1, weeklyAfter: 1, multiplier: 2 });
  assert.equal(split.overtime, 3);
  assert.ok(split.overtime <= split.total);
});

test('weeks are split on the configured week start', () => {
  // Sunday and Monday land in the same week when weeks start on Sunday,
  // and in different weeks when they start on Monday.
  const sunday = at(2026, 3, 1, 9);
  const monday = at(2026, 3, 2, 9);
  assert.equal(startOfWeek(sunday, 0), startOfWeek(monday, 0));
  assert.notEqual(startOfWeek(sunday, 1), startOfWeek(monday, 1));
});

/* ------------------------------------------------------------------ *
 * Summaries
 * ------------------------------------------------------------------ */

const job = {
  id: 'j1',
  name: 'Pressure washing',
  rate: 20,
  rounding: { mode: 'none', increment: 15 },
  overtime: { enabled: false },
  client: { name: 'Ellis Property Group' },
};

const entries = [
  { id: 'e1', jobId: 'j1', start: at(2026, 3, 2, 9), end: at(2026, 3, 2, 12), note: 'Driveway' },
  { id: 'e2', jobId: 'j1', start: at(2026, 3, 3, 13), end: at(2026, 3, 3, 17), note: 'Deck' },
];

test('summarize totals hours and pay per job', () => {
  const s = summarize(entries, { j1: job });
  assert.equal(s.jobs.length, 1);
  assert.equal(s.hours, 7);
  assert.equal(s.pay, 140);
  assert.equal(s.entryCount, 2);
});

test('summarize bills overtime as a premium above the base rate', () => {
  const otJob = { ...job, overtime: { enabled: true, dailyAfter: 2, weeklyAfter: 0, multiplier: 2 } };
  const s = summarize(entries, { j1: otJob });
  // 7h worked, 3h of it over the 2h/day line → 3h paid at an extra 1×.
  assert.equal(s.overtimeHours, 3);
  assert.equal(s.jobs[0].basePay, 140);
  assert.equal(s.jobs[0].overtimePremium, 60);
  assert.equal(s.pay, 200);
});

test('a job with no rate still totals hours and reports zero pay', () => {
  const s = summarize(entries, { j1: { ...job, rate: null } });
  assert.equal(s.hours, 7);
  assert.equal(s.pay, 0);
});

test('an entry whose job is gone is still counted, not dropped', () => {
  const s = summarize([{ id: 'x', jobId: 'missing', start: at(2026, 3, 2, 9), end: at(2026, 3, 2, 10) }], {});
  assert.equal(s.hours, 1);
  assert.equal(s.jobs.length, 1);
});

/* ------------------------------------------------------------------ *
 * Pay periods
 * ------------------------------------------------------------------ */

test('a weekly period runs from the configured week start', () => {
  const p = payPeriodFor(at(2026, 3, 4, 15), { type: 'weekly', weekStart: 1 });
  assert.equal(dayKey(p.start), '2026-03-02'); // the Monday
  assert.equal(dayKey(p.end - 1), '2026-03-08');
});

test('a monthly period covers exactly one calendar month', () => {
  const p = payPeriodFor(at(2026, 2, 14), { type: 'monthly' });
  assert.equal(dayKey(p.start), '2026-02-01');
  assert.equal(dayKey(p.end - 1), '2026-02-28');
});

test('a semimonthly period splits on the 16th', () => {
  const first = payPeriodFor(at(2026, 3, 10), { type: 'semimonthly' });
  assert.equal(dayKey(first.start), '2026-03-01');
  assert.equal(dayKey(first.end - 1), '2026-03-15');

  const second = payPeriodFor(at(2026, 3, 20), { type: 'semimonthly' });
  assert.equal(dayKey(second.start), '2026-03-16');
  assert.equal(dayKey(second.end - 1), '2026-03-31');
});

test('biweekly periods stay locked to their anchor', () => {
  const config = { type: 'biweekly', anchor: new Date(at(2026, 1, 4)).toISOString(), weekStart: 0 };
  const p1 = payPeriodFor(at(2026, 1, 10), config);
  assert.equal(dayKey(p1.start), '2026-01-04');

  const p2 = payPeriodFor(at(2026, 1, 18), config);
  assert.equal(dayKey(p2.start), '2026-01-18');

  // Well past a daylight-saving change, the cycle is still on the same footing.
  const p3 = payPeriodFor(at(2026, 7, 15), config);
  assert.equal(Math.round((p3.start - p1.start) / (14 * 24 * HOUR)) * 14 * 24 * HOUR > 0, true);
  assert.equal((p3.end - p3.start) / (24 * HOUR) >= 13.9, true);
});

test('a date before the anchor still lands in a whole period', () => {
  const config = { type: 'biweekly', anchor: new Date(at(2026, 3, 1)).toISOString(), weekStart: 0 };
  const p = payPeriodFor(at(2026, 2, 20), config);
  assert.ok(p.start <= at(2026, 2, 20));
  assert.ok(p.end > at(2026, 2, 20));
});

test('recent periods come back newest first and do not overlap', () => {
  for (const type of ['weekly', 'biweekly', 'semimonthly', 'monthly']) {
    const periods = recentPayPeriods(6, { type, weekStart: 0 }, at(2026, 3, 4));
    assert.equal(periods.length, 6, type);
    for (let i = 1; i < periods.length; i++) {
      assert.ok(periods[i].end <= periods[i - 1].start, `${type} periods overlap`);
      assert.equal(periods[i].end, periods[i - 1].start, `${type} periods leave a gap`);
    }
  }
});

test('an unanchored biweekly cycle is the same grid whatever day you ask about', () => {
  // Without this, each query defines its own fortnight and the list of recent
  // periods overlaps itself.
  const config = { type: 'biweekly', weekStart: 0 };
  const reference = payPeriodFor(at(2026, 3, 4), config);
  for (let day = 0; day < 14; day++) {
    const p = payPeriodFor(reference.start + day * 24 * HOUR + 6 * HOUR, config);
    assert.equal(p.start, reference.start);
    assert.equal(p.end, reference.end);
  }
  // And the neighbouring fortnight starts exactly where this one ends.
  assert.equal(payPeriodFor(reference.end + HOUR, config).start, reference.end);
});

test('exactly one recent period contains right now', () => {
  const now = at(2026, 3, 4, 11);
  for (const type of ['weekly', 'biweekly', 'semimonthly', 'monthly']) {
    const current = recentPayPeriods(6, { type, weekStart: 0 }, now)
      .filter((p) => now >= p.start && now < p.end);
    assert.equal(current.length, 1, `${type} reported ${current.length} current periods`);
  }
});

/* ------------------------------------------------------------------ *
 * Formatting and helpers
 * ------------------------------------------------------------------ */

test('durations format as hours and minutes', () => {
  assert.equal(formatDuration(66 * MINUTE), '1:06');
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(-5), '0:00');
});

test('hours format as decimals for billing', () => {
  assert.equal(formatHours(1.104), '1.1h');
  assert.equal(formatHours(2), '2h');
});

test('overlap detection ignores shifts that merely touch', () => {
  assert.equal(overlaps(0, 10, 10, 20), false);
  assert.equal(overlaps(0, 10, 9, 20), true);
  assert.equal(overlaps(5, 6, 0, 20), true);
});

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

test('CSV quotes cells containing commas, quotes or newlines', () => {
  assert.equal(toCSV([['a', 'b,c']]), 'a,"b,c"');
  assert.equal(toCSV([['say "hi"']]), '"say ""hi"""');
  assert.equal(toCSV([['line1\nline2']]), '"line1\nline2"');
});

test('the entries CSV has a header, a row per entry and a total', () => {
  const s = summarize(entries, { j1: job });
  const lines = entriesCSV(s, { currency: 'USD' }).split('\r\n');
  assert.match(lines[0], /^Date,Job,Client,Start,End/);
  assert.equal(lines.length, 5); // header + 2 entries + blank + total
  assert.match(lines.at(-1), /TOTAL,7,,140,USD/);
});

test('a note containing a comma cannot break the CSV row count', () => {
  const risky = [{ ...entries[0], note: 'Driveway, walkway and steps' }];
  const s = summarize(risky, { j1: job });
  const lines = entriesCSV(s, { currency: 'USD' }).split('\r\n');
  assert.equal(lines.length, 4);
  assert.ok(lines[1].includes('"Driveway, walkway and steps"'));
});

test('line items group per entry, per day and per job', () => {
  const sameDay = [
    { id: 'a', jobId: 'j1', start: at(2026, 3, 2, 9), end: at(2026, 3, 2, 11) },
    { id: 'b', jobId: 'j1', start: at(2026, 3, 2, 13), end: at(2026, 3, 2, 15) },
  ];
  const s = summarize(sameDay, { j1: job });
  assert.equal(buildLineItems(s, { groupBy: 'entry' }).length, 2);
  assert.equal(buildLineItems(s, { groupBy: 'day' }).length, 1);
  assert.equal(buildLineItems(s, { groupBy: 'job' }).length, 1);
  assert.equal(buildLineItems(s, { groupBy: 'day' })[0].hours, 4);
});

test('an overtime premium becomes its own line item', () => {
  const otJob = { ...job, overtime: { enabled: true, dailyAfter: 2, weeklyAfter: 0, multiplier: 2 } };
  const s = summarize(entries, { j1: otJob });
  const items = buildLineItems(s, { groupBy: 'job' });
  const premium = items.find((i) => i.description.includes('overtime premium'));
  assert.ok(premium);
  assert.equal(premium.amount, 60);
  assert.equal(premium.hours, null);
});

test('every line bills the hours it prints, so the arithmetic checks out', () => {
  // 1 hour and 1 second: printed as 1.00h, so the amount must be exactly the
  // rate — not the fraction of a cent the extra second is worth.
  const odd = [{ id: 'e', jobId: 'j1', start: at(2026, 3, 2, 9), end: at(2026, 3, 2, 10) + 1000 }];
  const s = summarize(odd, { j1: { ...job, rate: 42.5 } });
  const [item] = buildLineItems(s, { groupBy: 'entry' });
  assert.equal(item.hours, 1);
  assert.equal(item.amount, 42.5);
});

test('a shift too short to register bills nothing at all', () => {
  const blip = [{ id: 'e', jobId: 'j1', start: at(2026, 3, 2, 9), end: at(2026, 3, 2, 9) + 1200 }];
  const s = summarize(blip, { j1: { ...job, rate: 42.5 } });
  const [item] = buildLineItems(s, { groupBy: 'entry' });
  assert.equal(item.hours, 0);
  assert.equal(item.amount, 0);
});

test('the subtotal is exactly the sum of the printed line amounts', () => {
  const many = [1, 2, 3, 4, 5].map((d) => ({
    id: `e${d}`, jobId: 'j1',
    start: at(2026, 3, d, 9),
    end: at(2026, 3, d, 9) + (d * 37 + 20) * MINUTE, // deliberately awkward lengths
  }));
  const s = summarize(many, { j1: { ...job, rate: 33.33 } });
  const items = buildLineItems(s, { groupBy: 'entry' });
  const summed = items.reduce((acc, i) => acc + i.amount, 0);

  const html = buildDocument({
    summary: s,
    settings: { currency: 'USD', business: { name: 'T' } },
    meta: { title: 'Invoice', client: { name: 'C' } },
  });
  const shown = html.match(/Total due<\/td><td class="num">\$([\d,]+\.\d\d)/);
  assert.ok(shown, 'total due should be present');
  assert.equal(Number(shown[1].replace(/,/g, '')), Math.round(summed * 100) / 100);
});

test('the total shown in the app is the total billed on the invoice', () => {
  // Awkward shift lengths are where a full-precision app total and a
  // rounded-line invoice drift apart.
  const messy = [1, 2, 3, 4, 5, 6].map((d) => ({
    id: `e${d}`, jobId: 'j1',
    start: at(2026, 3, d, 8),
    end: at(2026, 3, d, 8) + (d * 53 + 7) * MINUTE + 37_000,
  }));
  const s = summarize(messy, { j1: { ...job, rate: 27.35 } });
  const items = buildLineItems(s, { groupBy: 'entry' });
  const invoiceSubtotal = round2(items.reduce((acc, i) => acc + i.amount, 0));
  assert.equal(s.pay, invoiceSubtotal);

  // Grouping the same hours by day or job re-rounds at a coarser grain, so a
  // cent of drift is expected — but each document still adds up internally.
  for (const groupBy of ['day', 'job']) {
    const grouped = buildLineItems(s, { groupBy });
    const subtotal = round2(grouped.reduce((acc, i) => acc + i.amount, 0));
    assert.ok(
      Math.abs(subtotal - invoiceSubtotal) <= 0.05,
      `${groupBy} subtotal ${subtotal} drifted from ${invoiceSubtotal}`
    );
  }
});

test('every printed line multiplies out exactly, whatever the grouping', () => {
  const messy = [1, 2, 3].map((d) => ({
    id: `e${d}`, jobId: 'j1',
    start: at(2026, 3, d, 8),
    end: at(2026, 3, d, 8) + (d * 41 + 13) * MINUTE + 29_000,
  }));
  const s = summarize(messy, { j1: { ...job, rate: 27.35 } });
  for (const groupBy of ['entry', 'day', 'job']) {
    for (const item of buildLineItems(s, { groupBy })) {
      if (item.hours == null || item.rate == null) continue;
      assert.equal(item.amount, round2(item.hours * item.rate), `${groupBy} line does not multiply out`);
    }
  }
});

test('the invoice document totals subtotal, tax and amount due', () => {
  const s = summarize(entries, { j1: job });
  const html = buildDocument({
    summary: s,
    settings: { currency: 'USD', business: { name: 'Taven' } },
    meta: { title: 'Invoice', invoiceNumber: 'INV-0001', taxRate: 10, client: { name: 'Ellis' } },
  });
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes('INV-0001'));
  assert.ok(html.includes('$140.00')); // subtotal
  assert.ok(html.includes('$14.00')); // 10% tax
  assert.ok(html.includes('$154.00')); // total due
  assert.ok(html.includes('Ellis'));
});

test('a timesheet shows hours but never rates or money', () => {
  const s = summarize(entries, { j1: job });
  const html = buildDocument({
    summary: s,
    settings: { currency: 'USD', business: { name: 'Taven' } },
    meta: { title: 'Timesheet', client: { name: 'Ellis' } },
  });
  assert.ok(html.includes('Total hours'));
  assert.ok(!html.includes('$140.00'));
  assert.ok(!html.includes('Total due'));
});

test('client-supplied text is escaped rather than injected into the document', () => {
  const s = summarize(entries, { j1: job });
  const html = buildDocument({
    summary: s,
    settings: { currency: 'USD', business: { name: '<script>alert(1)</script>' } },
    meta: { title: 'Invoice', client: { name: '"><img src=x onerror=alert(1)>' } },
  });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('escapeHtml covers every character that could break out of markup', () => {
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  assert.equal(escapeHtml(null), '');
});

test('mailto encodes spaces so subjects are not littered with plus signs', () => {
  const link = mailtoLink({ to: 'a@b.com', subject: 'Invoice 1', body: 'Hi there' });
  assert.ok(link.startsWith('mailto:a%40b.com?'));
  assert.ok(link.includes('subject=Invoice%201'));
  assert.ok(!link.includes('+'));
});
