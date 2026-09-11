/**
 * Local-first persistence. Everything lives in localStorage under one key so a
 * backup is a single JSON file and an import is a single assignment.
 *
 * The store is a tiny observable: mutate through the exported helpers, and
 * subscribers re-render. No framework needed at this size.
 */

import { DEFAULT_ROUNDING, DEFAULT_OVERTIME, DEFAULT_PAY_PERIOD } from './calc.js';

const KEY = 'hoursly.v1';
const SCHEMA_VERSION = 1;

export const JOB_COLORS = [
  '#34c759', '#0a84ff', '#ff9f0a', '#ff375f', '#bf5af2',
  '#5ac8fa', '#ffd60a', '#ff6482', '#64d2ff', '#30d158',
];

function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function newJob(overrides = {}) {
  return {
    id: uid('job'),
    name: '',
    color: JOB_COLORS[0],
    rate: null,
    rounding: { ...DEFAULT_ROUNDING },
    overtime: { ...DEFAULT_OVERTIME },
    autoBreak: { enabled: false, afterHours: 6, deductMinutes: 30 },
    tags: [],
    client: { name: '', email: '', address: '' },
    notes: '',
    archived: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function newEntry(overrides = {}) {
  return {
    id: uid('ent'),
    jobId: null,
    start: new Date().toISOString(),
    end: null,
    breakMinutes: 0,
    note: '',
    tags: [],
    billed: false,
    invoiceId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    jobs: [],
    entries: [],
    invoices: [],
    settings: {
      currency: 'USD',
      locale: '',
      weekStart: 0,
      theme: 'system',
      payPeriod: { ...DEFAULT_PAY_PERIOD },
      business: { name: '', email: '', phone: '', address: '' },
      taxRate: 0,
      taxLabel: 'Tax',
      invoicePrefix: 'INV-',
      invoiceSeq: 1,
      invoiceTerms: 'Payment due within 14 days.',
      lastJobId: null,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Load / save
 * ------------------------------------------------------------------ */

function migrate(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  // Merge shallowly per top-level key so a state written by an older build
  // still picks up fields added later.
  return {
    ...base,
    ...raw,
    settings: {
      ...base.settings,
      ...(raw.settings || {}),
      payPeriod: { ...base.settings.payPeriod, ...((raw.settings || {}).payPeriod || {}) },
      business: { ...base.settings.business, ...((raw.settings || {}).business || {}) },
    },
    jobs: (raw.jobs || []).map((j) => ({
      ...newJob(),
      ...j,
      rounding: { ...DEFAULT_ROUNDING, ...(j.rounding || {}) },
      overtime: { ...DEFAULT_OVERTIME, ...(j.overtime || {}) },
      autoBreak: { enabled: false, afterHours: 6, deductMinutes: 30, ...(j.autoBreak || {}) },
      client: { name: '', email: '', address: '', ...(j.client || {}) },
    })),
    entries: (raw.entries || []).map((e) => ({ ...newEntry(), ...e })),
    invoices: raw.invoices || [],
    schemaVersion: SCHEMA_VERSION,
  };
}

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    return migrate(raw ? JSON.parse(raw) : null);
  } catch (err) {
    console.error('Could not read saved data, starting fresh.', err);
    return defaultState();
  }
}

let state = read();
const listeners = new Set();
let saveTimer = null;

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    console.error('Could not save. Storage may be full or blocked.', err);
    notifyError(err);
  }
}

let errorHandler = null;
export function onStorageError(fn) {
  errorHandler = fn;
}
function notifyError(err) {
  if (errorHandler) errorHandler(err);
}

/** Subscribe to state changes. Returns an unsubscribe function. */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function commit() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 120); // coalesce bursts (e.g. typing)
  for (const fn of listeners) fn(state);
}

/** Flush any pending write immediately — used before unload. */
export function flush() {
  clearTimeout(saveTimer);
  persist();
}

export function getState() {
  return state;
}

/* ------------------------------------------------------------------ *
 * Selectors
 * ------------------------------------------------------------------ */

export function jobsById() {
  return new Map(state.jobs.map((j) => [j.id, j]));
}

export function getJob(id) {
  return state.jobs.find((j) => j.id === id) || null;
}

export function activeJobs() {
  return state.jobs.filter((j) => !j.archived);
}

export function getEntry(id) {
  return state.entries.find((e) => e.id === id) || null;
}

/** Entries sorted newest-first, optionally filtered. */
export function listEntries({ jobId = null, from = null, to = null, unbilledOnly = false } = {}) {
  return state.entries
    .filter((e) => {
      if (jobId && e.jobId !== jobId) return false;
      if (unbilledOnly && e.billed) return false;
      const start = new Date(e.start).getTime();
      if (from != null && start < from) return false;
      if (to != null && start >= to) return false;
      return true;
    })
    .sort((a, b) => new Date(b.start) - new Date(a.start));
}

/** The running entry, if the user is on the clock. */
export function runningEntry(jobId = null) {
  return state.entries.find((e) => !e.end && (!jobId || e.jobId === jobId)) || null;
}

/* ------------------------------------------------------------------ *
 * Mutations
 * ------------------------------------------------------------------ */

export function addJob(data) {
  const job = newJob(data);
  state.jobs.push(job);
  commit();
  return job;
}

export function updateJob(id, patch) {
  const job = getJob(id);
  if (!job) return null;
  Object.assign(job, patch);
  commit();
  return job;
}

export function deleteJob(id) {
  state.jobs = state.jobs.filter((j) => j.id !== id);
  state.entries = state.entries.filter((e) => e.jobId !== id);
  commit();
}

/** Duplicate a job's settings under a new name — the "copy from" flow. */
export function copyJob(id, name) {
  const src = getJob(id);
  if (!src) return null;
  const { id: _id, createdAt: _createdAt, ...settings } = structuredClone(src);
  const copy = newJob({ ...settings, name: name || `${src.name} copy` });
  state.jobs.push(copy);
  commit();
  return copy;
}

export function addEntry(data) {
  const entry = newEntry(data);
  state.entries.push(entry);
  commit();
  return entry;
}

export function updateEntry(id, patch) {
  const entry = getEntry(id);
  if (!entry) return null;
  Object.assign(entry, patch);
  commit();
  return entry;
}

export function deleteEntry(id) {
  state.entries = state.entries.filter((e) => e.id !== id);
  commit();
}

export function deleteEntries(ids) {
  const set = new Set(ids);
  state.entries = state.entries.filter((e) => !set.has(e.id));
  commit();
}

/**
 * Clock in. Any shift already running is clocked out first, so the app can
 * never end up with two open entries competing for the same minutes.
 */
export function clockIn(jobId, at = Date.now()) {
  const open = runningEntry();
  if (open) clockOut(open.id, at);
  const entry = newEntry({ jobId, start: new Date(at).toISOString() });
  state.entries.push(entry);
  state.settings.lastJobId = jobId;
  commit();
  return entry;
}

export function clockOut(entryId, at = Date.now()) {
  const entry = getEntry(entryId);
  if (!entry || entry.end) return null;
  const start = new Date(entry.start).getTime();
  entry.end = new Date(Math.max(at, start)).toISOString();
  commit();
  return entry;
}

export function setBilled(ids, billed, invoiceId = null) {
  const set = new Set(ids);
  for (const e of state.entries) {
    if (set.has(e.id)) {
      e.billed = billed;
      e.invoiceId = billed ? invoiceId : null;
    }
  }
  commit();
}

export function updateSettings(patch) {
  Object.assign(state.settings, patch);
  commit();
}

export function recordInvoice(invoice) {
  state.invoices.unshift(invoice);
  state.settings.invoiceSeq = (Number(state.settings.invoiceSeq) || 1) + 1;
  commit();
  return invoice;
}

export function nextInvoiceNumber() {
  const { invoicePrefix, invoiceSeq } = state.settings;
  return `${invoicePrefix || ''}${String(invoiceSeq || 1).padStart(4, '0')}`;
}

/* ------------------------------------------------------------------ *
 * Backup / restore
 * ------------------------------------------------------------------ */

export function exportBackup() {
  return JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2);
}

/**
 * Replace or merge saved data from a backup file.
 * @param {string} json
 * @param {'replace'|'merge'} mode
 */
export function importBackup(json, mode = 'replace') {
  const parsed = JSON.parse(json);
  const incoming = migrate(parsed);
  if (mode === 'merge') {
    const jobIds = new Set(state.jobs.map((j) => j.id));
    const entryIds = new Set(state.entries.map((e) => e.id));
    state.jobs.push(...incoming.jobs.filter((j) => !jobIds.has(j.id)));
    state.entries.push(...incoming.entries.filter((e) => !entryIds.has(e.id)));
  } else {
    state = incoming;
  }
  commit();
  flush();
  return state;
}

export function resetAll() {
  state = defaultState();
  commit();
  flush();
}

/* ------------------------------------------------------------------ *
 * Seed data — only ever offered on a genuinely empty install.
 * ------------------------------------------------------------------ */

export function isEmpty() {
  return state.jobs.length === 0 && state.entries.length === 0;
}

export function seedSample() {
  const job = addJob({
    name: 'Pressure washing',
    color: JOB_COLORS[1],
    rate: 25,
    client: { name: 'Ellis Property Group', email: '', address: '' },
  });
  const day = 24 * 3600_000;
  const now = Date.now();
  const shifts = [
    [3, 9, 12.5, 'Driveway + walkway'],
    [2, 13, 16, 'South elevation'],
    [1, 8.5, 11.75, 'Deck and fence'],
  ];
  for (const [daysAgo, from, to, note] of shifts) {
    const base = new Date(now - daysAgo * day);
    base.setHours(0, 0, 0, 0);
    addEntry({
      jobId: job.id,
      start: new Date(base.getTime() + from * 3600_000).toISOString(),
      end: new Date(base.getTime() + to * 3600_000).toISOString(),
      note,
    });
  }
  return job;
}

window.addEventListener('beforeunload', flush);
