/**
 * "Send to client" — turn a range of hours into an invoice, a timesheet, a CSV
 * or a plain-text summary, and get it out of the app.
 */

import * as store from '../store.js';
import {
  el, card, field, button, icon, toast, select, segmented, toggle, emptyState,
  confirmDialog, toDateInput, fromDateInput,
} from '../ui.js';
import { summarize, formatMoney, round, recentPayPeriods, addDays } from '../calc.js';
import {
  buildDocument, buildTextSummary, entriesCSV, downloadFile, openDocument,
  mailtoLink, slug, fmtRangeLabel,
} from '../export.js';

/** Range presets. Each resolves against the user's pay-period settings. */
function presets(settings) {
  const config = { ...settings.payPeriod, weekStart: settings.weekStart };
  const [current, previous] = recentPayPeriods(2, config);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();

  return [
    { id: 'period', label: 'This period', from: current.start, to: current.end },
    { id: 'last-period', label: 'Last period', from: previous.start, to: previous.end },
    { id: 'month', label: 'This month', from: monthStart, to: nextMonth },
    { id: 'last-month', label: 'Last month', from: lastMonthStart, to: monthStart },
    { id: 'all', label: 'All time', from: null, to: null },
    { id: 'custom', label: 'Custom…', from: null, to: null },
  ];
}

export function sendView({ setHeader, query, rerender }) {
  const state = store.getState();
  const settings = state.settings;
  const jobs = state.jobs;

  setHeader({ title: 'Send', back: '#/jobs' });

  if (!state.entries.length) {
    return el('div', { class: 'view' },
      emptyState('Nothing to send yet', 'Record some hours and they will show up here, ready to invoice.'));
  }

  const options = presets(settings);

  // Draft lives across re-renders of this view so edits are not lost.
  const draft = (sendView.draft ||= {});
  if (!draft.initialised) {
    const initialJob = query.job || '';
    const fromQuery = query.from ? Number(query.from) : null;
    const toQuery = query.to ? Number(query.to) : null;
    Object.assign(draft, {
      initialised: true,
      kind: 'Invoice',
      jobId: initialJob,
      preset: fromQuery ? 'custom' : 'period',
      from: fromQuery ?? options[0].from,
      to: toQuery ?? options[0].to,
      unbilledOnly: false,
      groupBy: 'entry',
      showTimes: true,
      invoiceNumber: store.nextInvoiceNumber(),
      issuedAt: Date.now(),
      dueDays: 14,
      taxRate: settings.taxRate || 0,
      notes: '',
      terms: settings.invoiceTerms || '',
      client: null,
    });
  }

  // Client details default to the selected job's client, but stay editable.
  const selectedJob = draft.jobId ? store.getJob(draft.jobId) : null;
  if (!draft.client || draft.clientFromJob !== draft.jobId) {
    draft.client = { ...(selectedJob?.client || { name: '', email: '', address: '' }) };
    draft.clientFromJob = draft.jobId;
  }

  const matching = store.listEntries({
    jobId: draft.jobId || null,
    from: draft.from,
    to: draft.to,
    unbilledOnly: draft.unbilledOnly,
  });
  // A shift that hasn't ended can't be invoiced — its total is still moving,
  // and "09:00 – running" has no business on a client's invoice.
  const stillRunning = matching.filter((e) => !e.end);
  const entries = matching.filter((e) => e.end);
  const summary = summarize(entries, store.jobsById(), { weekStart: settings.weekStart });

  const meta = () => ({
    title: draft.kind,
    invoiceNumber: draft.kind === 'Invoice' ? draft.invoiceNumber : '',
    issuedAt: draft.issuedAt,
    dueAt: draft.kind === 'Invoice' && draft.dueDays > 0 ? addDays(draft.issuedAt, Number(draft.dueDays)) : null,
    client: draft.client,
    from: draft.from,
    to: draft.to,
    groupBy: draft.groupBy,
    showTimes: draft.showTimes,
    taxRate: draft.taxRate,
    taxLabel: settings.taxLabel,
    notes: draft.notes,
    terms: draft.kind === 'Invoice' ? draft.terms : '',
  });

  const filenameBase = () =>
    `${slug(draft.kind)}-${slug(draft.client?.name || selectedJob?.name || 'hours')}-${toDateInput(draft.issuedAt)}`;

  const view = el('div', { class: 'view' });

  /* ---------------- What to send ---------------- */
  view.appendChild(
    el('section', {},
      el('h4', { class: 'section-title' }, 'What to send'),
      card(
        field('Document', segmented(
          [['Invoice', 'Invoice'], ['Timesheet', 'Timesheet']],
          draft.kind,
          (v) => { draft.kind = v; rerender(); }
        ), draft.kind === 'Invoice'
          ? 'Shows rates and an amount due.'
          : 'Hours only — no rates or totals in money.'),
        field('Job', select(
          [['', 'All jobs'], ...jobs.map((j) => [j.id, j.name])],
          draft.jobId,
          (v) => { draft.jobId = v; rerender(); }
        )),
        field('Dates', select(
          options.map((o) => [o.id, o.label]),
          draft.preset,
          (v) => {
            draft.preset = v;
            if (v !== 'custom') {
              const preset = options.find((o) => o.id === v);
              draft.from = preset.from;
              draft.to = preset.to;
            }
            rerender();
          }
        ), draft.from == null && draft.to == null ? null : fmtRangeLabel(draft.from, draft.to)),
        draft.preset === 'custom'
          ? el('div', { class: 'two-up sub-field' },
              field('From', el('input', {
                class: 'input', type: 'date', value: draft.from ? toDateInput(draft.from) : '',
                onChange: (e) => {
                  draft.from = e.target.value ? fromDateInput(e.target.value) : null;
                  rerender();
                },
              })),
              field('To', el('input', {
                class: 'input', type: 'date', value: draft.to ? toDateInput(draft.to - 1) : '',
                onChange: (e) => {
                  // The picker shows an inclusive last day; the range is half-open.
                  draft.to = e.target.value ? addDays(fromDateInput(e.target.value), 1) : null;
                  rerender();
                },
              }))
            )
          : null,
        el('div', { class: 'row' },
          el('span', { class: 'row-label' }, 'Unbilled hours only',
            el('small', {}, 'Skip anything already marked invoiced')),
          toggle(draft.unbilledOnly, (on) => { draft.unbilledOnly = on; rerender(); })
        )
      )
    )
  );

  /* ---------------- Live total ---------------- */
  view.appendChild(
    el('div', { class: `total-bar${entries.length ? '' : ' total-bar-empty'}` },
      el('span', { class: 'total-label' }, `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`),
      el('span', { class: 'total-pay' },
        draft.kind === 'Invoice' && summary.pay ? formatMoney(summary.pay, settings.currency, settings.locale) : ''),
      el('span', { class: 'total-hours' }, `${round(summary.hours, 2)}h`)
    )
  );

  if (!entries.length) {
    view.appendChild(
      el('p', { class: 'hint hint-warn' },
        stillRunning.length
          ? 'The only shift in this range is still running. Clock out to invoice it.'
          : 'No hours match this selection. Widen the dates, pick another job, or turn off “unbilled only”.')
    );
  } else if (stillRunning.length) {
    view.appendChild(
      el('p', { class: 'hint hint-warn' },
        `${stillRunning.length === 1 ? 'A shift is' : `${stillRunning.length} shifts are`} still running and left off — `,
        el('a', { href: `#/job/${stillRunning[0].jobId}` }, 'clock out'),
        ' first to include the time.')
    );
  }

  /* ---------------- Layout ---------------- */
  view.appendChild(
    el('section', {},
      el('h4', { class: 'section-title' }, 'Layout'),
      card(
        field('Group lines by', segmented(
          [['entry', 'Each shift'], ['day', 'Per day'], ['job', 'Per job']],
          draft.groupBy,
          (v) => { draft.groupBy = v; rerender(); }
        )),
        el('div', { class: 'row' },
          el('span', { class: 'row-label' }, 'Show clock times',
            el('small', {}, 'Start and end times beside each line')),
          toggle(draft.showTimes, (on) => { draft.showTimes = on; })
        )
      )
    )
  );

  /* ---------------- Recipient + invoice details ---------------- */
  const clientCard = card(
    field('Client', el('input', {
      class: 'input', type: 'text', value: draft.client.name, placeholder: 'Client or company name',
      onInput: (e) => { draft.client.name = e.target.value; },
    }), selectedJob?.client?.name ? `From the ${selectedJob.name} job` : 'Saved on the job so you only type it once'),
    field('Email', el('input', {
      class: 'input', type: 'email', value: draft.client.email, placeholder: 'billing@example.com',
      autocapitalize: 'off', autocorrect: 'off', spellcheck: false,
      onInput: (e) => { draft.client.email = e.target.value; },
    })),
    field('Address', el('textarea', {
      class: 'input', rows: 2, placeholder: 'Optional',
      onInput: (e) => { draft.client.address = e.target.value; },
    }, draft.client.address))
  );

  view.appendChild(
    el('section', {},
      el('h4', { class: 'section-title' }, draft.kind === 'Invoice' ? 'Bill to' : 'Prepared for'),
      clientCard
    )
  );

  if (draft.kind === 'Invoice') {
    view.appendChild(
      el('section', {},
        el('h4', { class: 'section-title' }, 'Invoice details'),
        card(
          el('div', { class: 'two-up' },
            field('Number', el('input', {
              class: 'input', type: 'text', value: draft.invoiceNumber,
              onInput: (e) => { draft.invoiceNumber = e.target.value; },
            })),
            field('Issued', el('input', {
              class: 'input', type: 'date', value: toDateInput(draft.issuedAt),
              onChange: (e) => {
                const ms = fromDateInput(e.target.value);
                if (Number.isFinite(ms)) draft.issuedAt = ms;
              },
            }))
          ),
          el('div', { class: 'two-up' },
            field('Due in', el('input', {
              class: 'input', type: 'number', min: '0', step: '1', value: draft.dueDays,
              onInput: (e) => { draft.dueDays = e.target.value; },
            }), 'days · 0 for none'),
            field(`${settings.taxLabel || 'Tax'} %`, el('input', {
              class: 'input', type: 'number', min: '0', step: '0.1', value: draft.taxRate,
              onInput: (e) => { draft.taxRate = Number(e.target.value) || 0; },
            }))
          ),
          field('Terms', el('textarea', {
            class: 'input', rows: 2, placeholder: 'Payment terms shown at the bottom',
            onInput: (e) => { draft.terms = e.target.value; },
          }, draft.terms))
        )
      )
    );
  }

  view.appendChild(
    el('section', {},
      el('h4', { class: 'section-title' }, 'Message'),
      card(
        field('Note to client', el('textarea', {
          class: 'input', rows: 2, placeholder: 'Thanks for the work this month…',
          onInput: (e) => { draft.notes = e.target.value; },
        }, draft.notes))
      )
    )
  );

  if (!settings.business.name) {
    view.appendChild(
      el('p', { class: 'hint hint-warn' },
        'Your own name and contact details are blank — ',
        el('a', { href: '#/settings' }, 'add them in Settings'),
        ' so the client knows who is billing them.')
    );
  }

  /* ---------------- Actions ---------------- */
  const disabled = entries.length === 0;

  const afterSend = async () => {
    if (draft.kind !== 'Invoice') return;
    const unbilled = entries.filter((e) => !e.billed);
    if (!unbilled.length) return;
    const ok = await confirmDialog({
      title: `Mark ${unbilled.length} ${unbilled.length === 1 ? 'entry' : 'entries'} as invoiced?`,
      message: 'They will be skipped next time you export unbilled hours only.',
      confirmLabel: 'Mark invoiced',
    });
    if (!ok) return;

    const invoiceId = draft.invoiceNumber;
    store.setBilled(unbilled.map((e) => e.id), true, invoiceId);
    store.recordInvoice({
      id: invoiceId,
      issuedAt: new Date(draft.issuedAt).toISOString(),
      client: draft.client.name,
      hours: round(summary.hours, 2),
      total: round(summary.pay * (1 + (Number(draft.taxRate) || 0) / 100), 2),
      currency: settings.currency,
      entryIds: unbilled.map((e) => e.id),
    });
    draft.invoiceNumber = store.nextInvoiceNumber();
    toast('Marked invoiced');
    rerender();
  };

  view.appendChild(
    el('section', { class: 'send-actions' },
      el('h4', { class: 'section-title' }, 'Deliver'),
      card(
        button('Preview & print to PDF', {
          variant: 'primary', icon: 'print', disabled,
          onClick: async () => {
            const html = buildDocument({ summary, settings, meta: meta() });
            if (!openDocument(html, { print: true })) {
              downloadFile(`${filenameBase()}.html`, html, 'text/html');
              toast('Popup blocked — downloaded instead', 'warn');
            }
            await afterSend();
          },
        }),
        button('Email to client', {
          variant: 'default', icon: 'mail', disabled,
          onClick: async () => {
            const text = buildTextSummary({ summary, settings, meta: meta() });
            const subject = `${draft.kind}${draft.kind === 'Invoice' ? ` ${draft.invoiceNumber}` : ''}${
              settings.business.name ? ` from ${settings.business.name}` : ''
            }`;
            const body = `${draft.notes ? `${draft.notes}\n\n` : ''}${text}`;
            // The document itself can't ride along in a mailto, so hand the
            // user the file too and let them attach it.
            const html = buildDocument({ summary, settings, meta: meta() });
            downloadFile(`${filenameBase()}.html`, html, 'text/html');
            window.location.href = mailtoLink({ to: draft.client.email, subject, body });
            toast('Summary in your email, document downloaded to attach');
            await afterSend();
          },
        }),
        typeof navigator !== 'undefined' && navigator.share
          ? button('Share…', {
              variant: 'default', icon: 'share', disabled,
              onClick: async () => {
                const text = buildTextSummary({ summary, settings, meta: meta() });
                try {
                  await navigator.share({ title: `${draft.kind} — ${draft.client.name || 'hours'}`, text });
                  await afterSend();
                } catch (err) {
                  if (err && err.name !== 'AbortError') toast('Could not share', 'warn');
                }
              },
            })
          : null,
        button('Download HTML document', {
          variant: 'default', icon: 'download', disabled,
          onClick: async () => {
            downloadFile(`${filenameBase()}.html`, buildDocument({ summary, settings, meta: meta() }), 'text/html');
            toast('Downloaded');
            await afterSend();
          },
        }),
        button('Download CSV', {
          variant: 'default', icon: 'table', disabled,
          onClick: () => {
            downloadFile(`${filenameBase()}.csv`, entriesCSV(summary, settings), 'text/csv');
            toast('CSV downloaded');
          },
        }),
        button('Copy summary as text', {
          variant: 'default', icon: 'copy', disabled,
          onClick: async () => {
            const text = buildTextSummary({ summary, settings, meta: meta() });
            try {
              await navigator.clipboard.writeText(text);
              toast('Copied to clipboard');
            } catch {
              downloadFile(`${filenameBase()}.txt`, text, 'text/plain');
              toast('Clipboard blocked — downloaded instead', 'warn');
            }
          },
        })
      ),
      el('p', { class: 'hint' },
        'The document is a single self-contained file: no tracking, no external requests. ',
        'Print it and choose “Save as PDF” to send a PDF.')
    )
  );

  return view;
}

/** Reset the draft when leaving the view, so the next export starts clean. */
export function resetSendDraft() {
  sendView.draft = null;
}
