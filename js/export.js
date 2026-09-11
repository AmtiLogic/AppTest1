/**
 * Everything that leaves the app: CSV for spreadsheets, a JSON backup, and
 * self-contained invoice / timesheet documents for sending to a client.
 *
 * The generated documents embed their own CSS and carry no scripts or external
 * requests, so they open anywhere, print cleanly, and can be emailed as-is.
 */

import {
  formatDuration,
  formatMoney,
  round,
  amountFor,
  billableHours,
  dayKey,
  MINUTE,
} from './calc.js';

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Turn a plain-text block into HTML, preserving the author's line breaks. */
function multiline(value) {
  return escapeHtml(value).replace(/\n/g, '<br>');
}

function fmtDate(ms, opts = { year: 'numeric', month: 'short', day: 'numeric' }) {
  return new Date(ms).toLocaleDateString(undefined, opts);
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function fmtRangeLabel(from, to) {
  if (from == null && to == null) return 'All time';
  if (from == null) return `Through ${fmtDate(to - 1)}`;
  if (to == null) return `From ${fmtDate(from)}`;
  return `${fmtDate(from)} – ${fmtDate(to - 1)}`;
}

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

function csvCell(value) {
  const s = String(value ?? '');
  // Quote when the value could otherwise break the row, and double any quotes.
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(rows) {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/**
 * Detailed per-entry CSV — the format a bookkeeper or payroll system wants.
 * @param {object} summary  result of calc.summarize()
 * @param {object} settings
 */
export function entriesCSV(summary, settings) {
  const rows = [[
    'Date', 'Job', 'Client', 'Start', 'End', 'Break (min)',
    'Hours', 'Rate', 'Amount', 'Currency', 'Tags', 'Note', 'Billed',
  ]];

  const flat = [];
  for (const group of summary.jobs) {
    for (const item of group.entries) flat.push({ group, ...item });
  }
  flat.sort((a, b) => a.metrics.start - b.metrics.start);

  for (const { group, entry, metrics } of flat) {
    rows.push([
      dayKey(metrics.start),
      group.job?.name || 'Unassigned',
      group.job?.client?.name || '',
      fmtTime(metrics.start),
      metrics.running ? '' : fmtTime(metrics.end),
      metrics.breakMinutes,
      billableHours(metrics.hours),
      group.rate || '',
      amountFor(metrics.hours, group.rate),
      settings.currency,
      (entry.tags || []).join(' '),
      entry.note || '',
      entry.billed ? 'yes' : 'no',
    ]);
  }

  rows.push([]);
  rows.push(['', '', '', '', '', 'TOTAL', round(summary.hours, 2), '', round(summary.pay, 2), settings.currency]);
  return toCSV(rows);
}

/* ------------------------------------------------------------------ *
 * Line items
 * ------------------------------------------------------------------ */

/**
 * Flatten a summary into printable line items.
 * @param {object} summary
 * @param {{groupBy:'entry'|'day'|'job', showTimes:boolean}} opts
 */
export function buildLineItems(summary, opts) {
  const { groupBy = 'entry', showTimes = true } = opts || {};
  const items = [];

  for (const group of summary.jobs) {
    const jobName = group.job?.name || 'Unassigned';

    if (groupBy === 'job') {
      const notes = group.entries.map((e) => e.entry.note).filter(Boolean);
      items.push({
        date: '',
        description: jobName,
        detail: `${group.entries.length} ${group.entries.length === 1 ? 'shift' : 'shifts'}${
          notes.length ? ` — ${[...new Set(notes)].join('; ')}` : ''
        }`,
        hours: group.hours,
        rate: group.rate,
        amount: group.hours * group.rate,
        sort: group.entries.length ? Math.min(...group.entries.map((e) => e.metrics.start)) : 0,
      });
    } else if (groupBy === 'day') {
      const byDay = new Map();
      for (const { entry, metrics, hours } of group.entries) {
        const key = dayKey(metrics.start);
        if (!byDay.has(key)) byDay.set(key, { hours: 0, notes: [], first: metrics.start, last: metrics.end });
        const bucket = byDay.get(key);
        bucket.hours = round(bucket.hours + hours, 2);
        bucket.first = Math.min(bucket.first, metrics.start);
        bucket.last = Math.max(bucket.last, metrics.end);
        if (entry.note) bucket.notes.push(entry.note);
      }
      for (const [key, bucket] of byDay) {
        items.push({
          date: fmtDate(bucket.first, { month: 'short', day: 'numeric', year: 'numeric' }),
          description: jobName,
          detail: [
            showTimes ? `${fmtTime(bucket.first)} – ${fmtTime(bucket.last)}` : '',
            [...new Set(bucket.notes)].join('; '),
          ].filter(Boolean).join(' · '),
          hours: bucket.hours,
          rate: group.rate,
          amount: bucket.hours * group.rate,
          sort: bucket.first,
          key,
        });
      }
    } else {
      for (const { entry, metrics, hours } of group.entries) {
        items.push({
          date: fmtDate(metrics.start, { month: 'short', day: 'numeric', year: 'numeric' }),
          description: jobName,
          detail: [
            showTimes ? `${fmtTime(metrics.start)} – ${metrics.running ? 'running' : fmtTime(metrics.end)}` : '',
            metrics.breakMinutes ? `less ${metrics.breakMinutes} min break` : '',
            entry.note || '',
          ].filter(Boolean).join(' · '),
          hours,
          rate: group.rate,
          amount: amountFor(hours, group.rate),
          sort: metrics.start,
        });
      }
    }

    if (group.overtimePremium > 0) {
      items.push({
        date: '',
        description: `${jobName} — overtime premium`,
        detail: `${round(group.overtimeHours, 2)}h at ${group.overtimeMultiplier}× base rate`,
        hours: null,
        rate: null,
        amount: group.overtimePremium,
        sort: Number.MAX_SAFE_INTEGER,
      });
    }
  }

  items.sort((a, b) => a.sort - b.sort);

  // Bill from the figures the client can actually see. Hours print to two
  // decimals, so the amount has to be that rounded figure times the rate —
  // otherwise a line reads "0.00 h × $42.50 = $0.03" and the invoice fails the
  // first check anyone does with a calculator.
  return items.map((item) => {
    const hours = item.hours == null ? null : billableHours(item.hours);
    const amount = hours != null && item.rate != null
      ? amountFor(hours, item.rate)
      : round(item.amount || 0, 2);
    return { ...item, hours, amount };
  });
}

/* ------------------------------------------------------------------ *
 * Invoice / timesheet document
 * ------------------------------------------------------------------ */

const DOC_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 32px;
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #16181d; background: #f4f5f7;
}
.sheet {
  max-width: 820px; margin: 0 auto; background: #fff; padding: 44px;
  border-radius: 14px; box-shadow: 0 1px 3px rgba(0,0,0,.12);
}
header { display: flex; flex-wrap: wrap; gap: 24px; justify-content: space-between; align-items: flex-start; }
h1 { margin: 0 0 2px; font-size: 28px; letter-spacing: -.02em; }
.doc-meta { text-align: right; font-size: 13px; color: #555c69; }
.doc-meta strong { color: #16181d; }
.brand { font-size: 15px; font-weight: 600; }
.muted { color: #6b7280; }
.parties { display: flex; flex-wrap: wrap; gap: 32px; margin: 32px 0 8px; }
.party { flex: 1 1 220px; }
.party h2 {
  font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
  color: #6b7280; margin: 0 0 6px; font-weight: 600;
}
table { width: 100%; border-collapse: collapse; margin-top: 24px; }
th, td { padding: 10px 8px; text-align: left; vertical-align: top; }
thead th {
  font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
  color: #6b7280; border-bottom: 2px solid #e5e7eb;
}
tbody tr { border-bottom: 1px solid #eef0f3; }
tbody tr:last-child { border-bottom: 0; }
.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.detail { display: block; color: #6b7280; font-size: 12.5px; margin-top: 2px; }
.totals { margin-top: 20px; margin-left: auto; width: min(320px, 100%); }
.totals tr td { padding: 6px 8px; }
.totals .grand td {
  border-top: 2px solid #16181d; font-size: 17px; font-weight: 700; padding-top: 12px;
}
footer { margin-top: 36px; padding-top: 18px; border-top: 1px solid #eef0f3; font-size: 12.5px; color: #6b7280; }
.badge {
  display: inline-block; padding: 3px 9px; border-radius: 999px;
  background: #eef2ff; color: #3730a3; font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: .06em;
}
@media print {
  body { padding: 0; background: #fff; }
  .sheet { box-shadow: none; border-radius: 0; max-width: none; padding: 0; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
}
@media (max-width: 640px) {
  body { padding: 12px; }
  .sheet { padding: 22px; }
  .doc-meta { text-align: left; }
}
`;

/**
 * Render a standalone invoice or timesheet.
 *
 * @param {object} opts
 * @param {object} opts.summary   calc.summarize() result
 * @param {object} opts.settings
 * @param {object} opts.meta      {title, invoiceNumber, issuedAt, dueAt, client, notes, from, to, groupBy, showTimes, showRates, taxRate, taxLabel, terms}
 * @returns {string} a complete HTML document
 */
export function buildDocument({ summary, settings, meta }) {
  const m = meta || {};
  const isInvoice = (m.title || 'Invoice') === 'Invoice';
  const showRates = m.showRates !== false && isInvoice;
  const currency = settings.currency || 'USD';
  const money = (n) => formatMoney(n, currency, settings.locale || undefined);
  const items = buildLineItems(summary, { groupBy: m.groupBy, showTimes: m.showTimes });

  // Every total is summed from the printed line values, so the document adds
  // up exactly as shown.
  const subtotal = round(items.reduce((s, i) => s + (i.amount || 0), 0), 2);
  const billedHours = round(items.reduce((s, i) => s + (i.hours || 0), 0), 2);
  const taxRate = Number(m.taxRate) || 0;
  const tax = round(subtotal * (taxRate / 100), 2);
  const total = round(subtotal + tax, 2);

  const business = settings.business || {};
  const client = m.client || {};

  const rows = items.map((item) => `
        <tr>
          <td class="date">${escapeHtml(item.date)}</td>
          <td>
            ${escapeHtml(item.description)}
            ${item.detail ? `<span class="detail">${escapeHtml(item.detail)}</span>` : ''}
          </td>
          <td class="num">${item.hours == null ? '' : item.hours.toFixed(2)}</td>
          ${showRates ? `<td class="num">${item.rate == null ? '' : money(item.rate)}</td>` : ''}
          ${showRates ? `<td class="num">${money(item.amount)}</td>` : ''}
        </tr>`).join('');

  const totalsBlock = showRates ? `
      <table class="totals">
        <tr><td class="muted">Hours</td><td class="num">${billedHours.toFixed(2)}</td></tr>
        <tr><td class="muted">Subtotal</td><td class="num">${money(subtotal)}</td></tr>
        ${taxRate ? `<tr><td class="muted">${escapeHtml(m.taxLabel || 'Tax')} (${round(taxRate, 3)}%)</td><td class="num">${money(tax)}</td></tr>` : ''}
        <tr class="grand"><td>Total due</td><td class="num">${money(total)}</td></tr>
      </table>` : `
      <table class="totals">
        <tr class="grand"><td>Total hours</td><td class="num">${billedHours.toFixed(2)}</td></tr>
      </table>`;

  const partyBlock = (heading, name, lines) => `
        <div class="party">
          <h2>${escapeHtml(heading)}</h2>
          <div class="brand">${escapeHtml(name || '—')}</div>
          ${lines.filter(Boolean).map((l) => `<div class="muted">${multiline(l)}</div>`).join('')}
        </div>`;

  const docTitle = `${m.title || 'Invoice'}${m.invoiceNumber ? ` ${m.invoiceNumber}` : ''}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(docTitle)}${client.name ? ` — ${escapeHtml(client.name)}` : ''}</title>
<style>${DOC_CSS}</style>
</head>
<body>
  <div class="sheet">
    <header>
      <div>
        <h1>${escapeHtml(m.title || 'Invoice')}</h1>
        <div class="muted">${escapeHtml(fmtRangeLabel(m.from, m.to))}</div>
      </div>
      <div class="doc-meta">
        ${m.invoiceNumber ? `<div><span class="badge">${escapeHtml(m.invoiceNumber)}</span></div>` : ''}
        <div style="margin-top:8px">Issued <strong>${escapeHtml(fmtDate(m.issuedAt || Date.now()))}</strong></div>
        ${m.dueAt ? `<div>Due <strong>${escapeHtml(fmtDate(m.dueAt))}</strong></div>` : ''}
      </div>
    </header>

    <div class="parties">
      ${partyBlock('From', business.name, [business.address, business.email, business.phone])}
      ${partyBlock(isInvoice ? 'Bill to' : 'Prepared for', client.name, [client.address, client.email])}
    </div>

    <table>
      <thead>
        <tr>
          <th style="width:15%">Date</th>
          <th>Description</th>
          <th class="num" style="width:10%">Hours</th>
          ${showRates ? '<th class="num" style="width:13%">Rate</th>' : ''}
          ${showRates ? '<th class="num" style="width:15%">Amount</th>' : ''}
        </tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">No hours in this range.</td></tr>'}</tbody>
    </table>

    ${totalsBlock}

    ${m.notes || m.terms ? `<footer>
      ${m.notes ? `<p>${multiline(m.notes)}</p>` : ''}
      ${m.terms ? `<p>${multiline(m.terms)}</p>` : ''}
    </footer>` : ''}
  </div>
</body>
</html>`;
}

/* ------------------------------------------------------------------ *
 * Plain-text summary — for a chat message or the body of an email
 * ------------------------------------------------------------------ */

export function buildTextSummary({ summary, settings, meta }) {
  const m = meta || {};
  const money = (n) => formatMoney(n, settings.currency || 'USD', settings.locale || undefined);
  const lines = [];
  lines.push(`${m.title || 'Timesheet'}${m.invoiceNumber ? ` ${m.invoiceNumber}` : ''}`);
  lines.push(fmtRangeLabel(m.from, m.to));
  lines.push('');

  for (const group of summary.jobs) {
    lines.push(`${group.job?.name || 'Unassigned'} — ${round(group.hours, 2).toFixed(2)}h`);
    for (const { entry, metrics } of [...group.entries].sort((a, b) => a.metrics.start - b.metrics.start)) {
      const time = `${fmtTime(metrics.start)}–${metrics.running ? 'running' : fmtTime(metrics.end)}`;
      lines.push(
        `  ${fmtDate(metrics.start, { month: 'short', day: 'numeric' })}  ${time}  ` +
        `${formatDuration(metrics.worked)}${entry.note ? `  ${entry.note}` : ''}`
      );
    }
    if (group.rate) lines.push(`  Amount: ${money(group.pay)}`);
    lines.push('');
  }

  lines.push(`Total: ${round(summary.hours, 2).toFixed(2)}h${summary.pay ? ` · ${money(summary.pay)}` : ''}`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Delivery
 * ------------------------------------------------------------------ */

export function downloadFile(filename, content, mime = 'text/plain') {
  // A BOM keeps Excel from mangling non-ASCII characters in CSV.
  const body = mime.startsWith('text/csv') ? `﻿${content}` : content;
  const blob = new Blob([body], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Open a generated document in its own tab, ready to print or save as PDF.
 * Returns false if a popup blocker got in the way, so the caller can fall back
 * to a download.
 */
export function openDocument(html, { print = false } = {}) {
  const win = window.open('', '_blank');
  if (!win) return false;
  win.document.open();
  win.document.write(html);
  win.document.close();
  if (print) {
    // Give the new document a tick to lay out before the print dialog opens.
    win.addEventListener('load', () => setTimeout(() => win.print(), 120));
  }
  return true;
}

export function mailtoLink({ to, subject, body }) {
  const params = new URLSearchParams();
  if (subject) params.set('subject', subject);
  if (body) params.set('body', body);
  // URLSearchParams encodes spaces as '+', which mail clients show literally.
  const query = params.toString().replace(/\+/g, '%20');
  return `mailto:${encodeURIComponent(to || '')}${query ? `?${query}` : ''}`;
}

export function slug(value, fallback = 'export') {
  const s = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || fallback;
}

export { fmtDate, fmtTime, fmtRangeLabel, MINUTE };
