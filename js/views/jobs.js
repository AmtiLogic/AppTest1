/** Jobs list and job detail — the home of clocking in and out. */

import * as store from '../store.js';
import {
  el, card, button, icon, toast, emptyState, actionSheet, friendlyDay, timeLabel,
} from '../ui.js';
import {
  entryMetrics, summarize, formatStopwatch, formatMoney, round, amountFor,
} from '../calc.js';
import { editJob, editEntry, clockInAt } from './editors.js';
import { navigate } from '../router.js';

/* ------------------------------------------------------------------ *
 * Jobs list
 * ------------------------------------------------------------------ */

export function jobsView({ setHeader }) {
  const state = store.getState();
  const running = store.runningEntry();

  const showArchived = new URLSearchParams(location.hash.split('?')[1] || '').get('archived') === '1';
  const hasArchived = state.jobs.some((j) => j.archived);

  setHeader({
    title: 'Jobs',
    actions: [
      { icon: 'plus', label: 'New job', onClick: () => newJobFlow() },
      hasArchived
        ? {
            text: showArchived ? 'Hide old' : 'Archived',
            onClick: () => navigate(showArchived ? '#/jobs' : '#/jobs?archived=1'),
          }
        : null,
    ].filter(Boolean),
  });

  const view = el('div', { class: 'view' });

  const search = el('input', {
    class: 'input search', type: 'search', placeholder: 'Search jobs', 'aria-label': 'Search jobs',
    onInput: (e) => renderList(e.target.value.trim().toLowerCase()),
  });
  view.appendChild(el('div', { class: 'search-wrap' }, icon('search', 18), search));

  const list = el('div', { class: 'list-wrap' });
  view.appendChild(list);

  function renderList(query = '') {
    list.replaceChildren();
    const jobs = state.jobs.filter((j) => {
      if (j.archived && !showArchived) return false;
      if (!query) return true;
      return (
        j.name.toLowerCase().includes(query) ||
        (j.client?.name || '').toLowerCase().includes(query) ||
        (j.tags || []).some((t) => t.toLowerCase().includes(query))
      );
    });

    if (!jobs.length) {
      list.appendChild(
        state.jobs.length
          ? emptyState('Nothing matches', 'Try a different search.')
          : emptyState(
              'Start with a job',
              'A job is one client and one hourly rate. Track hours against it, then send that client an invoice.',
              el('div', { class: 'empty-actions' },
                button('Create your first job', { variant: 'primary', icon: 'plus', onClick: () => newJobFlow() }),
                button('Try it with sample data', {
                  variant: 'ghost',
                  onClick: () => {
                    store.seedSample();
                    toast('Sample job added');
                  },
                })
              )
            )
      );
      return;
    }

    const onClock = jobs.filter((j) => running && running.jobId === j.id);
    const offClock = jobs.filter((j) => !(running && running.jobId === j.id));

    if (onClock.length) list.appendChild(jobGroup('On the clock', onClock, running, 'on'));
    if (offClock.length) list.appendChild(jobGroup('Off the clock', offClock, running, 'off'));

    // One nudge, only while it is still true: a brand-new job list gives no clue
    // what "Start" does or where the hours end up.
    if (!store.getState().entries.length) {
      list.appendChild(
        el('p', { class: 'hint hint-tip' },
          'Tap ', el('strong', {}, 'Start'), ' to clock in, or open a job to add hours by hand. ',
          'When you’re ready to bill, go to ', el('strong', {}, 'Send'), '.')
      );
    }
  }

  renderList();
  return view;
}

function jobGroup(title, jobs, running, tone) {
  return el('section', { class: 'group' },
    el('div', { class: `group-head group-${tone}` }, title),
    card(jobs.map((job) => jobRow(job, running)))
  );
}

function jobRow(job, running) {
  const isRunning = running && running.jobId === job.id;
  const metrics = isRunning ? entryMetrics(running, job) : null;
  const otherRunning = running && running.jobId !== job.id;

  return el('div', { class: 'job-row' },
    el('button', {
      class: 'job-main', type: 'button', onClick: () => navigate(`#/job/${job.id}`),
    },
      el('span', { class: 'color-dot sm', style: { background: job.color } }),
      el('span', { class: 'job-text' },
        el('span', { class: 'job-name' }, job.name),
        el('small', {},
          [
            job.client?.name,
            job.rate ? `${formatMoney(job.rate, store.getState().settings.currency)}/h` : null,
            job.archived ? 'archived' : null,
          ].filter(Boolean).join(' · ') || 'No rate set'
        )
      ),
      isRunning
        ? el('span', { class: 'running-pill', dataset: { tick: running.id } }, formatStopwatch(metrics.elapsed))
        : null
    ),
    // Clocking in is far and away the most common thing anyone does here, so it
    // is one labelled tap from the list rather than a trip through a menu.
    el('button', {
      class: `job-clock${isRunning ? ' job-clock-stop' : ''}`,
      type: 'button',
      'aria-label': isRunning ? `Clock out of ${job.name}` : `Clock in to ${job.name}`,
      onClick: () => {
        if (isRunning) {
          store.clockOut(running.id);
          toast('Clocked out');
        } else {
          store.clockIn(job.id);
          toast(otherRunning ? `Switched to ${job.name}` : `Clocked in — ${job.name}`);
        }
      },
    }, el('span', {}, isRunning ? 'Stop' : 'Start'))
  );
}

async function jobMenu(job) {
  const running = store.runningEntry(job.id);
  const choice = await actionSheet(job.name, [
    running
      ? { value: 'out', label: 'Clock out now', icon: 'stop' }
      : { value: 'in', label: 'Clock in now', icon: 'play' },
    { value: 'add', label: 'Add entry', icon: 'plus' },
    { value: 'edit', label: 'Edit job', icon: 'edit' },
    { value: 'copy', label: 'Duplicate job', icon: 'copy' },
    { value: 'send', label: 'Send hours to client', icon: 'send' },
    { value: 'archive', label: job.archived ? 'Unarchive' : 'Archive', icon: 'archive' },
  ]);

  switch (choice) {
    case 'in': store.clockIn(job.id); toast(`Clocked in — ${job.name}`); break;
    case 'out': store.clockOut(running.id); toast('Clocked out'); break;
    case 'add': editEntry(null, { jobId: job.id }); break;
    case 'edit': editJob(job); break;
    case 'copy': editJob(null, { copyFrom: job }); break;
    case 'send': navigate(`#/send?job=${job.id}`); break;
    case 'archive':
      store.updateJob(job.id, { archived: !job.archived });
      toast(job.archived ? 'Job restored' : 'Job archived');
      break;
    default: break;
  }
}

/** New job, with the option to copy an existing job's settings. */
async function newJobFlow() {
  const jobs = store.activeJobs();
  if (!jobs.length) return editJob(null);

  const choice = await actionSheet('New job', [
    { value: '__blank', label: 'Start from scratch', icon: 'plus' },
    ...jobs.slice(0, 6).map((j) => ({ value: j.id, label: `Copy from ${j.name}`, icon: 'copy' })),
  ]);
  if (!choice) return undefined;
  return editJob(null, choice === '__blank' ? {} : { copyFrom: store.getJob(choice) });
}

/* ------------------------------------------------------------------ *
 * Job detail
 * ------------------------------------------------------------------ */

export function jobDetailView({ params, setHeader }) {
  const job = store.getJob(params.id);
  if (!job) {
    return el('div', { class: 'view' }, emptyState('Job not found', 'It may have been deleted.',
      button('Back to jobs', { variant: 'primary', onClick: () => navigate('#/jobs') })));
  }

  const settings = store.getState().settings;
  const running = store.runningEntry(job.id);
  const entries = store.listEntries({ jobId: job.id });
  const summary = summarize(entries, store.jobsById(), { weekStart: settings.weekStart });

  setHeader({
    title: 'Job',
    back: '#/jobs',
    actions: [
      { text: 'Edit', onClick: () => editJob(job) },
      { icon: 'more', label: 'More actions', onClick: () => jobMenu(job) },
    ],
  });

  const view = el('div', { class: 'view' });

  view.appendChild(
    el('h2', { class: 'job-title', style: { color: job.color } }, job.name)
  );

  if (job.client?.name) {
    view.appendChild(el('p', { class: 'job-client' }, `for ${job.client.name}`));
  }

  /* Clock controls */
  view.appendChild(
    running
      ? el('div', { class: 'clock-bar' },
          el('div', { class: 'clock-live' },
            el('span', { class: 'clock-elapsed', dataset: { tick: running.id } },
              formatStopwatch(entryMetrics(running, job).elapsed)),
            el('small', {}, `since ${timeLabel(new Date(running.start).getTime())}`)
          ),
          button('Clock Out', {
            variant: 'stop',
            onClick: () => { store.clockOut(running.id); toast('Clocked out'); },
          })
        )
      : el('div', { class: 'clock-bar' },
          button('Clock In Now', { variant: 'go', onClick: () => { store.clockIn(job.id); toast('Clocked in'); } }),
          button('Start At…', { variant: 'go', onClick: () => clockInAt(job.id) })
        )
  );

  /* Totals */
  const group = summary.jobs[0];
  view.appendChild(
    el('div', { class: 'total-bar' },
      el('span', { class: 'total-label' }, 'TOTAL'),
      el('span', { class: 'total-pay' }, group?.pay ? formatMoney(group.pay, settings.currency, settings.locale) : ''),
      el('span', { class: 'total-hours' }, `${round(summary.hours, 2)}h`)
    )
  );

  view.appendChild(
    el('div', { class: 'quick-row' },
      button('Add Entry', { variant: 'ghost', icon: 'plus', onClick: () => editEntry(null, { jobId: job.id }) }),
      button('Send hours', { variant: 'ghost', icon: 'send', onClick: () => navigate(`#/send?job=${job.id}`) })
    )
  );

  /* Entries */
  if (!entries.length) {
    view.appendChild(emptyState('No hours yet', 'Clock in, or add an entry by hand.'));
    return view;
  }

  const byDay = new Map();
  for (const entry of entries) {
    const m = entryMetrics(entry, job);
    const key = new Date(m.start).toDateString();
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push({ entry, m });
  }

  const list = el('div', { class: 'list-wrap' });
  for (const [, items] of byDay) {
    list.appendChild(
      el('section', { class: 'group' },
        el('div', { class: 'group-head' },
          el('span', {}, friendlyDay(items[0].m.start)),
          el('span', {}, `${round(items.reduce((s, i) => s + i.m.hours, 0), 2)}h`)
        ),
        card(items.map(({ entry, m }) => entryRow(entry, m, job, settings)))
      )
    );
  }
  view.appendChild(list);
  return view;
}

/** One entry line, shared with the Entries view. */
export function entryRow(entry, metrics, job, settings, { showJob = false } = {}) {
  return el('button', {
    class: `entry-row${metrics.running ? ' entry-running' : ''}`,
    type: 'button',
    onClick: () => editEntry(entry),
  },
    el('span', { class: 'entry-main' },
      showJob
        ? el('span', { class: 'entry-job' },
            el('span', { class: 'color-dot xs', style: { background: job?.color || '#888' } }),
            job?.name || 'Unassigned')
        : null,
      el('span', { class: 'entry-times' },
        `${timeLabel(metrics.start)} – ${metrics.running ? 'now' : timeLabel(metrics.end)}`,
        metrics.breakMinutes ? el('em', {}, ` −${metrics.breakMinutes}m break`) : null
      ),
      entry.note ? el('small', { class: 'entry-note' }, entry.note) : null,
      entry.billed ? el('span', { class: 'tag tag-billed' }, 'invoiced') : null,
      (entry.tags || []).map((t) => el('span', { class: 'tag' }, t))
    ),
    el('span', { class: 'entry-figures' },
      job?.rate
        ? el('span', { class: 'entry-pay' },
            formatMoney(amountFor(metrics.hours, job.rate), settings.currency, settings.locale))
        : null,
      el('span', {
        class: 'entry-hours',
        dataset: metrics.running ? { tick: entry.id, ticktype: 'hours' } : {},
      }, `${round(metrics.hours, 2)}h`)
    ),
    icon('chevron', 14)
  );
}

