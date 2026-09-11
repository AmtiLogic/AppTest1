/** Pay periods: what each period earned, and where the hours went. */

import * as store from '../store.js';
import { el, card, button, icon, emptyState, select } from '../ui.js';
import {
  summarize, recentPayPeriods, formatMoney, round, startOfDay, addDays, dayKey,
} from '../calc.js';
import { navigate } from '../router.js';

const PERIOD_TYPES = [
  ['weekly', 'Weekly'],
  ['biweekly', 'Every 2 weeks'],
  ['semimonthly', 'Twice a month'],
  ['monthly', 'Monthly'],
];

export function reportsView({ setHeader, rerender }) {
  const state = store.getState();
  const settings = state.settings;
  const config = { ...settings.payPeriod, weekStart: settings.weekStart };

  setHeader({
    title: 'Pay Periods',
    actions: [{ icon: 'send', label: 'Send to client', onClick: () => navigate('#/send') }],
  });

  const view = el('div', { class: 'view' });

  view.appendChild(
    el('div', { class: 'filters' },
      select(PERIOD_TYPES, config.type, (v) => {
        store.updateSettings({ payPeriod: { ...settings.payPeriod, type: v } });
        rerender();
      })
    )
  );

  if (!state.entries.length) {
    view.appendChild(emptyState('No hours yet', 'Pay periods fill in once you record some time.'));
    return view;
  }

  const jobsById = store.jobsById();
  const periods = recentPayPeriods(8, config);

  for (const period of periods) {
    const entries = store.listEntries({ from: period.start, to: period.end });
    const summary = summarize(entries, jobsById, { weekStart: settings.weekStart });
    const isCurrent = Date.now() >= period.start && Date.now() < period.end;
    if (!entries.length && !isCurrent) continue;

    view.appendChild(periodCard(period, summary, settings, isCurrent));
  }

  return view;
}

function periodLabel(period) {
  const opts = { month: 'short', day: 'numeric' };
  const start = new Date(period.start);
  const end = new Date(period.end - 1);
  const sameYear = start.getFullYear() === end.getFullYear();
  const yearSuffix = sameYear && start.getFullYear() === new Date().getFullYear()
    ? ''
    : ` ${end.getFullYear()}`;
  return `${start.toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(undefined, opts)}${yearSuffix}`;
}

function periodCard(period, summary, settings, isCurrent) {
  const section = el('section', { class: 'group' },
    el('div', { class: 'group-head' },
      el('span', {}, periodLabel(period), isCurrent ? el('em', { class: 'now-pill' }, 'current') : null),
      el('span', {}, `${round(summary.hours, 2)}h`)
    )
  );

  const body = el('div', { class: 'card' });

  if (!summary.jobs.length) {
    body.appendChild(el('div', { class: 'row' }, el('span', { class: 'row-label muted' }, 'No hours recorded')));
    section.appendChild(body);
    return section;
  }

  body.appendChild(dailyChart(period, summary, settings));

  for (const group of summary.jobs) {
    body.appendChild(
      el('div', { class: 'period-job' },
        el('span', { class: 'color-dot xs', style: { background: group.job?.color || '#888' } }),
        el('span', { class: 'period-job-text' },
          el('span', {}, group.job?.name || 'Unassigned'),
          group.overtimeHours > 0
            ? el('small', {}, `${round(group.regularHours, 2)}h regular + ${round(group.overtimeHours, 2)}h OT`)
            : el('small', {}, `${group.entries.length} ${group.entries.length === 1 ? 'shift' : 'shifts'}`)
        ),
        el('span', { class: 'period-figures' },
          group.pay ? el('span', { class: 'entry-pay' }, formatMoney(group.pay, settings.currency, settings.locale)) : null,
          el('span', { class: 'entry-hours' }, `${round(group.hours, 2)}h`)
        )
      )
    );
  }

  body.appendChild(
    el('div', { class: 'period-total' },
      el('span', {}, 'Period total'),
      el('strong', {}, summary.pay ? formatMoney(summary.pay, settings.currency, settings.locale) : `${round(summary.hours, 2)}h`)
    )
  );

  body.appendChild(
    el('div', { class: 'quick-row' },
      button('Send this period', {
        variant: 'ghost', icon: 'send',
        onClick: () => navigate(`#/send?from=${period.start}&to=${period.end}`),
      })
    )
  );

  section.appendChild(body);
  return section;
}

/** A compact per-day bar chart — enough to spot a heavy week at a glance. */
function dailyChart(period, summary, settings) {
  const totals = new Map();
  for (const group of summary.jobs) {
    for (const { metrics } of group.entries) {
      const key = dayKey(metrics.start);
      totals.set(key, (totals.get(key) || 0) + metrics.hours);
    }
  }

  const days = [];
  // Cap the axis so a monthly period stays readable on a phone.
  const maxDays = 31;
  for (let cursor = period.start, i = 0; cursor < period.end && i < maxDays; cursor = addDays(cursor, 1), i++) {
    days.push({ ms: cursor, hours: totals.get(dayKey(cursor)) || 0 });
  }

  const peak = Math.max(1, ...days.map((d) => d.hours));
  const today = startOfDay(Date.now());

  return el('div', { class: 'chart', role: 'img', 'aria-label': `Hours per day, peak ${round(peak, 1)} hours` },
    days.map((d) =>
      el('span', {
        class: `bar${d.ms === today ? ' bar-today' : ''}${d.hours ? '' : ' bar-empty'}`,
        style: { '--h': `${Math.max(d.hours ? 6 : 2, (d.hours / peak) * 100)}%` },
        title: `${new Date(d.ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} — ${round(d.hours, 2)}h`,
      })
    )
  );
}
