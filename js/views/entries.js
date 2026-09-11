/** All entries across every job, with filters and bulk actions. */

import * as store from '../store.js';
import {
  el, card, button, icon, toast, emptyState, confirmDialog, friendlyDay, select, segmented,
} from '../ui.js';
import { entryMetrics, summarize, formatMoney, round, payPeriodFor } from '../calc.js';
import { editEntry } from './editors.js';
import { entryRow } from './jobs.js';

const RANGES = [
  ['period', 'This period'],
  ['week', 'This week'],
  ['month', 'This month'],
  ['all', 'All'],
];

/** Resolve a named range to `[from, to)` in epoch ms. */
export function rangeFor(name, settings, now = Date.now()) {
  const d = new Date(now);
  switch (name) {
    case 'week': {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      const shift = (start.getDay() - (settings.weekStart || 0) + 7) % 7;
      start.setDate(start.getDate() - shift);
      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      return { from: start.getTime(), to: end.getTime() };
    }
    case 'month':
      return {
        from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
        to: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(),
      };
    case 'period': {
      const p = payPeriodFor(now, { ...settings.payPeriod, weekStart: settings.weekStart });
      return { from: p.start, to: p.end };
    }
    case 'all':
    default:
      return { from: null, to: null };
  }
}

let uiState = { range: 'period', jobId: '', selecting: false, selected: new Set() };

export function entriesView({ setHeader, rerender }) {
  const settings = store.getState().settings;
  const jobs = store.getState().jobs;

  setHeader({
    title: 'Hours',
    actions: [
      {
        text: uiState.selecting ? 'Done' : 'Select',
        onClick: () => {
          uiState.selecting = !uiState.selecting;
          uiState.selected.clear();
          rerender();
        },
      },
      { icon: 'plus', label: 'Add entry', onClick: () => editEntry(null) },
    ],
  });

  const view = el('div', { class: 'view' });

  /* Filters */
  view.appendChild(
    el('div', { class: 'filters' },
      segmented(RANGES, uiState.range, (v) => { uiState.range = v; rerender(); }),
      jobs.length > 1
        ? select(
            [['', 'All jobs'], ...jobs.map((j) => [j.id, j.name])],
            uiState.jobId,
            (v) => { uiState.jobId = v; rerender(); }
          )
        : null
    )
  );

  const { from, to } = rangeFor(uiState.range, settings);
  const entries = store.listEntries({ jobId: uiState.jobId || null, from, to });
  const jobsById = store.jobsById();
  const summary = summarize(entries, jobsById, { weekStart: settings.weekStart });

  view.appendChild(
    el('div', { class: 'total-bar' },
      el('span', { class: 'total-label' }, `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`),
      el('span', { class: 'total-pay' }, summary.pay ? formatMoney(summary.pay, settings.currency, settings.locale) : ''),
      el('span', { class: 'total-hours' }, `${round(summary.hours, 2)}h`)
    )
  );

  if (!entries.length) {
    view.appendChild(
      emptyState(
        'Nothing here',
        uiState.range === 'all'
          ? 'Clock in from the Jobs tab, or add an entry by hand.'
          : 'Nothing in this range. Your older hours are still here — tap “All” above to see them.',
        button('Add entry', { variant: 'primary', icon: 'plus', onClick: () => editEntry(null) })
      )
    );
    return view;
  }

  /* Grouped list */
  const byDay = new Map();
  for (const entry of entries) {
    const job = jobsById.get(entry.jobId);
    const m = entryMetrics(entry, job);
    const key = new Date(m.start).toDateString();
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push({ entry, m, job });
  }

  const list = el('div', { class: 'list-wrap' });
  for (const [, items] of byDay) {
    const dayHours = items.reduce((s, i) => s + i.m.hours, 0);
    list.appendChild(
      el('section', { class: 'group' },
        el('div', { class: 'group-head' },
          el('span', {}, friendlyDay(items[0].m.start)),
          el('span', {}, `${round(dayHours, 2)}h`)
        ),
        card(items.map(({ entry, m, job }) =>
          uiState.selecting
            ? selectableRow(entry, m, job, settings, rerender)
            : entryRow(entry, m, job, settings, { showJob: !uiState.jobId })
        ))
      )
    );
  }
  view.appendChild(list);

  if (uiState.selecting) view.appendChild(bulkBar(rerender));
  return view;
}

function selectableRow(entry, metrics, job, settings, rerender) {
  const checked = uiState.selected.has(entry.id);
  return el('div', { class: `select-row${checked ? ' select-on' : ''}` },
    el('button', {
      class: 'select-box', type: 'button', 'aria-pressed': checked,
      'aria-label': checked ? 'Deselect entry' : 'Select entry',
      onClick: () => {
        if (checked) uiState.selected.delete(entry.id);
        else uiState.selected.add(entry.id);
        rerender();
      },
    }, icon(checked ? 'check-circle' : 'circle', 22)),
    entryRow(entry, metrics, job, settings, { showJob: true })
  );
}

function bulkBar(rerender) {
  const ids = [...uiState.selected];
  const disabled = !ids.length;
  return el('div', { class: 'bulk-bar' },
    el('span', {}, `${ids.length} selected`),
    el('div', { class: 'bulk-actions' },
      button('Invoiced', {
        variant: 'ghost', disabled,
        onClick: () => { store.setBilled(ids, true); toast(`${ids.length} marked invoiced`); uiState.selected.clear(); rerender(); },
      }),
      button('Unbilled', {
        variant: 'ghost', disabled,
        onClick: () => { store.setBilled(ids, false); toast(`${ids.length} marked unbilled`); uiState.selected.clear(); rerender(); },
      }),
      button('Delete', {
        variant: 'danger', disabled,
        onClick: async () => {
          const ok = await confirmDialog({
            title: `Delete ${ids.length} ${ids.length === 1 ? 'entry' : 'entries'}?`,
            message: 'This can’t be undone.',
            confirmLabel: 'Delete',
            destructive: true,
          });
          if (ok) {
            store.deleteEntries(ids);
            uiState.selected.clear();
            toast('Deleted');
            rerender();
          }
        },
      })
    )
  );
}
