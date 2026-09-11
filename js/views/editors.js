/** The job and entry editor sheets, shared by every view that can edit them. */

import * as store from '../store.js';
import { JOB_COLORS } from '../store.js';
import {
  el, field, sheet, select, toggle, toast, button, confirmDialog,
  toLocalInput, fromLocalInput,
} from '../ui.js';
import { entryMetrics, formatDuration, overlaps, MINUTE } from '../calc.js';

const ROUND_INCREMENTS = [
  [1, '1 minute'], [5, '5 minutes'], [6, '6 minutes (1/10 h)'],
  [10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'],
];

function colorPicker(value, onChange) {
  const wrap = el('div', { class: 'colors' });
  for (const color of JOB_COLORS) {
    wrap.appendChild(
      el('button', {
        type: 'button',
        class: `swatch${color === value ? ' swatch-on' : ''}`,
        style: { background: color },
        'aria-label': `Colour ${color}`,
        onClick: () => {
          value = color;
          for (const b of wrap.children) b.classList.remove('swatch-on');
          wrap.children[JOB_COLORS.indexOf(color)].classList.add('swatch-on');
          onChange(color);
        },
      })
    );
  }
  return wrap;
}

/**
 * Create or edit a job.
 * @param {object|null} existing
 * @param {{copyFrom?:object}} [opts]
 */
export function editJob(existing, opts = {}) {
  const draft = existing
    ? structuredClone(existing)
    : store.newJob(
        opts.copyFrom
          ? (() => {
              const { id, createdAt, name, ...rest } = structuredClone(opts.copyFrom);
              return rest;
            })()
          : {}
      );

  return sheet({
    title: existing ? 'Edit Job' : 'New Job',
    subtitle: !existing && opts.copyFrom ? `copy from ${opts.copyFrom.name}` : null,
    fullHeight: true,
    confirmLabel: 'Save',
    onConfirm: () => {
      const name = draft.name.trim();
      if (!name) {
        toast('Give the job a name first', 'warn');
        return false;
      }
      draft.name = name;
      draft.rate = draft.rate === '' || draft.rate == null ? null : Number(draft.rate);
      if (existing) store.updateJob(existing.id, draft);
      else store.addJob(draft);
      toast(existing ? 'Job updated' : `“${name}” added`);
      return true;
    },
    render: (api) => {
      const body = el('div', { class: 'form' });

      const nameInput = el('input', {
        class: 'input input-lg', type: 'text', value: draft.name,
        placeholder: 'Job Name', autocapitalize: 'words',
        onInput: (e) => { draft.name = e.target.value; },
      });

      body.appendChild(
        el('div', { class: 'card' },
          el('div', { class: 'name-row' },
            nameInput,
            el('span', { class: 'color-dot', style: { background: draft.color } })
          ),
          field('Hourly rate', el('input', {
            class: 'input', type: 'number', inputmode: 'decimal', step: '0.01', min: '0',
            value: draft.rate ?? '', placeholder: 'Optional — leave blank to track hours only',
            onInput: (e) => { draft.rate = e.target.value; },
          })),
          colorPicker(draft.color, (c) => {
            draft.color = c;
            body.querySelector('.color-dot').style.background = c;
          })
        )
      );

      /* -- Time rules -- */
      const roundingIncrement = el('div', { class: 'sub-field' },
        field('Increment', select(ROUND_INCREMENTS, draft.rounding.increment, (v) => {
          draft.rounding.increment = Number(v);
        }))
      );
      roundingIncrement.hidden = draft.rounding.mode === 'none';

      body.appendChild(
        el('section', {},
          el('h4', { class: 'section-title' }, 'Time rules'),
          el('div', { class: 'card' },
            field('Round time',
              select(
                [['none', 'No rounding'], ['nearest', 'To nearest'], ['up', 'Always up'], ['down', 'Always down']],
                draft.rounding.mode,
                (v) => {
                  draft.rounding.mode = v;
                  roundingIncrement.hidden = v === 'none';
                }
              ),
              'Applied to each shift’s length, so billed time always matches the rule.'
            ),
            roundingIncrement
          )
        )
      );

      /* -- Automatic breaks -- */
      const breakFields = el('div', { class: 'sub-field two-up' },
        field('After', el('input', {
          class: 'input', type: 'number', step: '0.5', min: '0', value: draft.autoBreak.afterHours,
          onInput: (e) => { draft.autoBreak.afterHours = Number(e.target.value); },
        }), 'hours worked'),
        field('Deduct', el('input', {
          class: 'input', type: 'number', step: '5', min: '0', value: draft.autoBreak.deductMinutes,
          onInput: (e) => { draft.autoBreak.deductMinutes = Number(e.target.value); },
        }), 'minutes')
      );
      breakFields.hidden = !draft.autoBreak.enabled;

      body.appendChild(
        el('section', {},
          el('h4', { class: 'section-title' }, 'Automatic breaks'),
          el('div', { class: 'card' },
            el('div', { class: 'row' },
              el('span', { class: 'row-label' }, 'Deduct an unpaid break',
                el('small', {}, 'Skipped when you record a break yourself')),
              toggle(draft.autoBreak.enabled, (on) => {
                draft.autoBreak.enabled = on;
                breakFields.hidden = !on;
              })
            ),
            breakFields
          )
        )
      );

      /* -- Overtime -- */
      const otFields = el('div', { class: 'sub-field' },
        el('div', { class: 'two-up' },
          field('Daily after', el('input', {
            class: 'input', type: 'number', step: '0.5', min: '0', value: draft.overtime.dailyAfter,
            onInput: (e) => { draft.overtime.dailyAfter = Number(e.target.value); },
          }), 'hours · 0 to disable'),
          field('Weekly after', el('input', {
            class: 'input', type: 'number', step: '1', min: '0', value: draft.overtime.weeklyAfter,
            onInput: (e) => { draft.overtime.weeklyAfter = Number(e.target.value); },
          }), 'hours · 0 to disable')
        ),
        field('Rate multiplier', el('input', {
          class: 'input', type: 'number', step: '0.25', min: '1', value: draft.overtime.multiplier,
          onInput: (e) => { draft.overtime.multiplier = Number(e.target.value); },
        }), 'Overtime shows on invoices as a separate premium line.')
      );
      otFields.hidden = !draft.overtime.enabled;

      body.appendChild(
        el('section', {},
          el('h4', { class: 'section-title' }, 'Overtime'),
          el('div', { class: 'card' },
            el('div', { class: 'row' },
              el('span', { class: 'row-label' }, 'Pay overtime'),
              toggle(draft.overtime.enabled, (on) => {
                draft.overtime.enabled = on;
                otFields.hidden = !on;
              })
            ),
            otFields
          )
        )
      );

      /* -- Client -- */
      body.appendChild(
        el('section', {},
          el('h4', { class: 'section-title' }, 'Client'),
          el('div', { class: 'card' },
            field('Name', el('input', {
              class: 'input', type: 'text', value: draft.client.name, placeholder: 'Who gets the invoice',
              onInput: (e) => { draft.client.name = e.target.value; },
            })),
            field('Email', el('input', {
              class: 'input', type: 'email', value: draft.client.email, placeholder: 'billing@example.com',
              autocapitalize: 'off', autocorrect: 'off',
              onInput: (e) => { draft.client.email = e.target.value; },
            })),
            field('Address', el('textarea', {
              class: 'input', rows: 3, placeholder: 'Shown on the invoice',
              onInput: (e) => { draft.client.address = e.target.value; },
            }, draft.client.address))
          ),
          el('p', { class: 'hint' }, 'Used to pre-fill invoices and timesheets for this job.')
        )
      );

      /* -- Tags + notes -- */
      body.appendChild(
        el('section', {},
          el('h4', { class: 'section-title' }, 'Extras'),
          el('div', { class: 'card' },
            field('Tags', el('input', {
              class: 'input', type: 'text', value: (draft.tags || []).join(', '),
              placeholder: 'e.g. exterior, warranty',
              onInput: (e) => {
                draft.tags = e.target.value.split(',').map((t) => t.trim()).filter(Boolean);
              },
            }), 'Comma separated'),
            field('Notes', el('textarea', {
              class: 'input', rows: 2, placeholder: 'Anything you want to remember',
              onInput: (e) => { draft.notes = e.target.value; },
            }, draft.notes || ''))
          )
        )
      );

      if (existing) {
        body.appendChild(
          el('section', {},
            button('Delete job and its entries', {
              variant: 'danger-ghost',
              onClick: async () => {
                const count = store.listEntries({ jobId: existing.id }).length;
                const ok = await confirmDialog({
                  title: `Delete “${existing.name}”?`,
                  message: count
                    ? `This also deletes ${count} time ${count === 1 ? 'entry' : 'entries'}. It can’t be undone — export a backup first if you need one.`
                    : 'This can’t be undone.',
                  confirmLabel: 'Delete',
                  destructive: true,
                });
                if (ok) {
                  store.deleteJob(existing.id);
                  toast('Job deleted');
                  location.hash = '#/jobs';
                  api.close(false);
                }
              },
            })
          )
        );
      }

      return body;
    },
  });
}

/* ------------------------------------------------------------------ *
 * Entry editor
 * ------------------------------------------------------------------ */

/** Warn when a shift would double-book minutes already claimed by another. */
function findOverlap(draft, ignoreId) {
  const start = fromLocalInput(draft.startLocal);
  const end = draft.endLocal ? fromLocalInput(draft.endLocal) : null;
  if (!Number.isFinite(start) || end == null || !Number.isFinite(end)) return null;
  return store.getState().entries.find((e) => {
    if (e.id === ignoreId || !e.end) return false;
    return overlaps(start, end, new Date(e.start).getTime(), new Date(e.end).getTime());
  }) || null;
}

/**
 * Create or edit a time entry.
 * @param {object|null} existing
 * @param {{jobId?:string, start?:number, end?:number}} [defaults]
 */
export function editEntry(existing, defaults = {}) {
  const jobs = store.activeJobs();
  if (!jobs.length && !existing) {
    toast('Add a job first', 'warn');
    return Promise.resolve(false);
  }

  const now = Date.now();
  const draft = {
    jobId: existing?.jobId || defaults.jobId || store.getState().settings.lastJobId || jobs[0]?.id,
    startLocal: toLocalInput(existing ? new Date(existing.start).getTime() : defaults.start ?? now - 3600_000),
    endLocal: existing
      ? (existing.end ? toLocalInput(new Date(existing.end).getTime()) : '')
      : toLocalInput(defaults.end ?? now),
    breakMinutes: existing?.breakMinutes || 0,
    note: existing?.note || '',
    tags: existing?.tags || [],
    billed: existing?.billed || false,
  };

  let refreshTotal = () => {};

  return sheet({
    title: existing ? 'Edit Entry' : 'Add Entry',
    fullHeight: true,
    confirmLabel: 'Save',
    onConfirm: async () => {
      const start = fromLocalInput(draft.startLocal);
      if (!Number.isFinite(start)) {
        toast('Set a start time', 'warn');
        return false;
      }
      const end = draft.endLocal ? fromLocalInput(draft.endLocal) : null;
      if (end != null && Number.isFinite(end) && end < start) {
        toast('The end time is before the start', 'warn');
        return false;
      }
      const clash = findOverlap(draft, existing?.id);
      if (clash) {
        const job = store.getJob(clash.jobId);
        const ok = await confirmDialog({
          title: 'Overlapping shift',
          message: `This overlaps an entry on ${job?.name || 'another job'}. Save it anyway?`,
          confirmLabel: 'Save anyway',
        });
        if (!ok) return false;
      }

      const payload = {
        jobId: draft.jobId,
        start: new Date(start).toISOString(),
        end: end != null && Number.isFinite(end) ? new Date(end).toISOString() : null,
        breakMinutes: Number(draft.breakMinutes) || 0,
        note: draft.note.trim(),
        tags: draft.tags,
        billed: draft.billed,
      };

      if (existing) store.updateEntry(existing.id, payload);
      else store.addEntry(payload);
      toast(existing ? 'Entry updated' : 'Entry added');
      return true;
    },
    render: (api) => {
      const total = el('div', { class: 'total-strip' });

      refreshTotal = () => {
        const start = fromLocalInput(draft.startLocal);
        const end = draft.endLocal ? fromLocalInput(draft.endLocal) : null;
        const job = store.getJob(draft.jobId);
        if (!Number.isFinite(start) || end == null || !Number.isFinite(end) || end < start) {
          total.textContent = end != null && Number.isFinite(end) && end < start
            ? 'End is before start'
            : 'Running — no end time yet';
          total.className = 'total-strip total-warn';
          return;
        }
        const m = entryMetrics(
          { start, end, breakMinutes: Number(draft.breakMinutes) || 0 },
          job
        );
        const rate = Number(job?.rate) || 0;
        total.className = 'total-strip';
        total.textContent = `${formatDuration(m.worked)} · ${m.hours.toFixed(2)}h${
          rate ? ` · ${(m.hours * rate).toFixed(2)}` : ''
        }${m.rounded !== m.elapsed ? ` (rounded from ${formatDuration(m.elapsed)})` : ''}`;
      };

      const body = el('div', { class: 'form' },
        el('div', { class: 'card' },
          field('Job', select(
            store.getState().jobs.map((j) => [j.id, j.name + (j.archived ? ' (archived)' : '')]),
            draft.jobId,
            (v) => { draft.jobId = v; refreshTotal(); }
          )),
          field('Start', el('input', {
            class: 'input', type: 'datetime-local', value: draft.startLocal,
            onInput: (e) => { draft.startLocal = e.target.value; refreshTotal(); },
          })),
          field('End', el('input', {
            class: 'input', type: 'datetime-local', value: draft.endLocal,
            onInput: (e) => { draft.endLocal = e.target.value; refreshTotal(); },
          }), 'Leave empty to leave the shift running'),
          field('Break', el('input', {
            class: 'input', type: 'number', min: '0', step: '5', inputmode: 'numeric',
            value: draft.breakMinutes,
            onInput: (e) => { draft.breakMinutes = e.target.value; refreshTotal(); },
          }), 'Unpaid minutes to deduct'),
          total
        ),
        el('div', { class: 'card' },
          field('Note', el('textarea', {
            class: 'input', rows: 3, placeholder: 'What you worked on — this shows on the invoice',
            onInput: (e) => { draft.note = e.target.value; },
          }, draft.note)),
          field('Tags', el('input', {
            class: 'input', type: 'text', value: draft.tags.join(', '), placeholder: 'Comma separated',
            onInput: (e) => { draft.tags = e.target.value.split(',').map((t) => t.trim()).filter(Boolean); },
          })),
          el('div', { class: 'row' },
            el('span', { class: 'row-label' }, 'Already invoiced',
              el('small', {}, 'Invoiced entries are hidden from “unbilled only” exports')),
            toggle(draft.billed, (on) => { draft.billed = on; })
          )
        ),
        el('div', { class: 'quick-row' },
          [15, 30, 60, 120].map((mins) =>
            button(`+${mins < 60 ? `${mins}m` : `${mins / 60}h`}`, {
              variant: 'ghost',
              onClick: () => {
                const start = fromLocalInput(draft.startLocal);
                const base = draft.endLocal ? fromLocalInput(draft.endLocal) : start;
                if (!Number.isFinite(base)) return;
                draft.endLocal = toLocalInput(base + mins * MINUTE);
                body.querySelectorAll('input[type="datetime-local"]')[1].value = draft.endLocal;
                refreshTotal();
              },
            })
          )
        )
      );

      if (existing) {
        body.appendChild(
          button('Delete entry', {
            variant: 'danger-ghost',
            onClick: async () => {
              const ok = await confirmDialog({
                title: 'Delete this entry?',
                message: 'This can’t be undone.',
                confirmLabel: 'Delete',
                destructive: true,
              });
              if (ok) {
                store.deleteEntry(existing.id);
                toast('Entry deleted');
                api.close(true);
              }
            },
          })
        );
      }

      refreshTotal();
      return body;
    },
  });
}

/** "Start at…" — clock in at a time the user picks, for a shift already begun. */
export function clockInAt(jobId) {
  let value = toLocalInput(Date.now());
  return sheet({
    title: 'Start At…',
    subtitle: store.getJob(jobId)?.name,
    confirmLabel: 'Clock in',
    onConfirm: () => {
      const at = fromLocalInput(value);
      if (!Number.isFinite(at)) {
        toast('Pick a start time', 'warn');
        return false;
      }
      if (at > Date.now() + MINUTE) {
        toast('That start time is in the future', 'warn');
        return false;
      }
      store.clockIn(jobId, at);
      toast('Clocked in');
      return true;
    },
    render: () => el('div', { class: 'form' },
      el('div', { class: 'card' },
        field('Started at', el('input', {
          class: 'input', type: 'datetime-local', value,
          onInput: (e) => { value = e.target.value; },
        }), 'Use this when you forgot to clock in when the shift began.')
      ),
      el('div', { class: 'quick-row' },
        [5, 15, 30, 60, 120].map((mins) =>
          button(`${mins < 60 ? `${mins} min` : `${mins / 60} h`} ago`, {
            variant: 'ghost',
            onClick: (e) => {
              value = toLocalInput(Date.now() - mins * MINUTE);
              e.target.closest('.form').querySelector('input').value = value;
            },
          })
        )
      )
    ),
  });
}
