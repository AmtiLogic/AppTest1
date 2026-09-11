# Hoursly

Track hours and pay for every job, then send the client a clean invoice or
timesheet. A phone-first web app that installs to the home screen, works with no
signal, and keeps every entry on the device — no account, no server, no upload.

Built as static files: open `index.html` and it runs. No build step, no
dependencies, no bundler.

## What it does

**Track**
- Jobs with a colour, hourly rate, client details and notes
- **Start** / **Stop** on every row of the jobs list — clocking in is one tap
  from the home screen, and starting a second job stops the first
- **Start at…** for a shift already under way, plus a live timer that follows
  you around the app
- Add and edit shifts by hand, with breaks, notes and tags
- A warning when a shift you're saving overlaps one you already recorded

**Rules that match how the job is actually billed**
- Per-job rounding — to the nearest, always up, or always down, from 1 minute to
  an hour
- Automatic unpaid breaks after a set number of hours, skipped when you record a
  break yourself
- Overtime after a daily and/or weekly threshold at a rate multiplier, counted so
  an hour is never paid as overtime twice

**Review**
- Hours grouped by day, filtered by job and date range, with multi-select to
  delete or mark invoiced in bulk
- Pay periods — weekly, fortnightly, twice-monthly or monthly — each with a
  per-day chart and a per-job breakdown

**Send to a client** — its own tab, because it is the point of the app
- **Invoice** with line items, rates, tax and an amount due, or **Timesheet**
  with hours only and no money anywhere on the page
- Pick a job and a date range and the deliver buttons are right there; layout,
  billing details and the covering note sit below for when you want them
- Group lines by shift, by day or by job; show or hide clock times
- Print to PDF, email, share, download as HTML, export CSV, or copy a plain-text
  summary
- Mark the entries invoiced afterwards so the next export can skip them
- Invoice numbers increment on their own

**Your data**
- Export a full JSON backup; restore it by replacing or merging
- Nothing leaves the device unless you send it

## Running it

```bash
npm start          # serve at http://localhost:8080
npm test           # unit tests for the time, pay and export logic
```

Any static host works — GitHub Pages, Netlify, an S3 bucket, or a folder opened
over `file://`. The service worker and "add to home screen" need `https://` or
`localhost`.

## How the numbers work

Worth knowing, because these are the decisions that make an invoice add up:

- **Rounding applies to a shift's length**, not to the clock times, so billed
  time always matches the stated rule exactly.
- **Rounding happens before breaks come off.** A 1h50m shift with "round up to
  30 minutes" and a 20-minute break bills 1h40m.
- **Hours are billed in hundredths of an hour**, and every amount is that
  rounded figure times the rate. A printed line always multiplies out, so a
  client checking the arithmetic gets the same answer. Grouping the same hours
  by day instead of by shift re-rounds at a coarser grain and can land a cent
  apart — ordinary invoice rounding, and each document always adds up against
  itself.
- **Overtime is billed as a premium.** Every hour appears once at the plain
  rate, and the extra above it is a separate line, the way payroll states it.
- **Days and weeks are local to the device**, so a shift starting at 23:00
  belongs to the day you'd say it did.
- **A running shift is never invoiced.** It's left out of exports, with a note
  telling you to clock out first.

## Layout

```
index.html            shell and icon sprite
css/app.css           dark-first theme, light via prefers-color-scheme
js/calc.js            time, rounding, overtime, pay periods — pure, unit tested
js/store.js           state, persistence, migrations, backup/restore
js/export.js          CSV, invoice/timesheet documents, plain-text summary
js/ui.js              DOM helpers, sheets, dialogs, toasts
js/router.js          hash router
js/app.js             shell, routing, live timer
js/views/             jobs, entries, reports, send, settings, editors
sw.js                 offline cache
test/                 node --test suite
```

`calc.js` and `export.js` hold every rule about time and money and touch neither
the DOM nor storage, which is what makes them straightforward to test.

## Notes

- Data lives in `localStorage` under one key, so a backup is a single file.
  Clearing site data erases it — export a backup first.
- Private browsing can block storage entirely; the app says so rather than
  losing work quietly.
- Generated invoices are self-contained HTML: no scripts, no tracking, no
  external requests. Print and "Save as PDF" to send a PDF.
