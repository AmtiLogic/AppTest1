/** Settings: your details, money, pay periods, and backup/restore. */

import * as store from '../store.js';
import {
  el, card, field, row, button, select, toast, confirmDialog, toDateInput, fromDateInput,
} from '../ui.js';
import { downloadFile } from '../export.js';
import { navigate } from '../router.js';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'SEK', 'NOK', 'DKK', 'CAD', 'AUD', 'NZD', 'CHF', 'JPY', 'INR', 'ZAR', 'PLN', 'MXN', 'BRL'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function settingsView({ setHeader, rerender }) {
  const state = store.getState();
  const s = state.settings;

  setHeader({ title: 'More', actions: [] });

  const view = el('div', { class: 'view' });
  const set = (patch) => store.updateSettings(patch);

  /* -- Your details (these head every invoice) -- */
  view.appendChild(
    el('section', {},
      el('h4', { class: 'section-title' }, 'Your details'),
      card(
        field('Name or business', el('input', {
          class: 'input', type: 'text', value: s.business.name, placeholder: 'Shown as the sender',
          onInput: (e) => set({ business: { ...s.business, name: e.target.value } }),
        })),
        field('Email', el('input', {
          class: 'input', type: 'email', value: s.business.email, autocapitalize: 'off', spellcheck: false,
          onInput: (e) => set({ business: { ...s.business, email: e.target.value } }),
        })),
        field('Phone', el('input', {
          class: 'input', type: 'tel', value: s.business.phone,
          onInput: (e) => set({ business: { ...s.business, phone: e.target.value } }),
        })),
        field('Address', el('textarea', {
          class: 'input', rows: 2,
          onInput: (e) => set({ business: { ...s.business, address: e.target.value } }),
        }, s.business.address))
      ),
      el('p', { class: 'hint' }, 'These appear in the “From” block of every invoice and timesheet.')
    )
  );

  /* -- Money -- */
  view.appendChild(
    el('section', {},
      el('h4', { class: 'section-title' }, 'Money'),
      card(
        field('Currency', select(CURRENCIES.map((c) => [c, c]), s.currency, (v) => { set({ currency: v }); rerender(); })),
        el('div', { class: 'two-up' },
          field('Tax label', el('input', {
            class: 'input', type: 'text', value: s.taxLabel, placeholder: 'VAT, GST, Sales tax',
            onInput: (e) => set({ taxLabel: e.target.value }),
          })),
          field('Default rate %', el('input', {
            class: 'input', type: 'number', min: '0', step: '0.1', value: s.taxRate,
            onInput: (e) => set({ taxRate: Number(e.target.value) || 0 }),
          }))
        ),
        el('div', { class: 'two-up' },
          field('Invoice prefix', el('input', {
            class: 'input', type: 'text', value: s.invoicePrefix, placeholder: 'INV-',
            onInput: (e) => set({ invoicePrefix: e.target.value }),
          })),
          field('Next number', el('input', {
            class: 'input', type: 'number', min: '1', step: '1', value: s.invoiceSeq,
            onInput: (e) => set({ invoiceSeq: Math.max(1, Number(e.target.value) || 1) }),
          }))
        ),
        field('Default terms', el('textarea', {
          class: 'input', rows: 2,
          onInput: (e) => set({ invoiceTerms: e.target.value }),
        }, s.invoiceTerms))
      )
    )
  );

  /* -- Pay periods -- */
  view.appendChild(
    el('section', {},
      el('h4', { class: 'section-title' }, 'Pay periods'),
      card(
        field('Length', select(
          [['weekly', 'Weekly'], ['biweekly', 'Every 2 weeks'], ['semimonthly', 'Twice a month'], ['monthly', 'Monthly']],
          s.payPeriod.type,
          (v) => { set({ payPeriod: { ...s.payPeriod, type: v } }); rerender(); }
        )),
        field('Week starts on', select(
          DAYS.map((d, i) => [i, d]), s.weekStart, (v) => set({ weekStart: Number(v) })
        )),
        s.payPeriod.type === 'biweekly'
          ? field('First period started', el('input', {
              class: 'input', type: 'date',
              value: s.payPeriod.anchor ? toDateInput(new Date(s.payPeriod.anchor).getTime()) : '',
              onChange: (e) => set({
                payPeriod: {
                  ...s.payPeriod,
                  anchor: e.target.value ? new Date(fromDateInput(e.target.value)).toISOString() : null,
                },
              }),
            }), 'Anchors the two-week cycle')
          : null
      )
    )
  );

  /* -- Appearance -- */
  view.appendChild(
    el('section', {},
      el('h4', { class: 'section-title' }, 'Appearance'),
      card(
        field('Theme', select(
          [['system', 'Match device'], ['dark', 'Always dark'], ['light', 'Always light']],
          s.theme,
          (v) => { set({ theme: v }); applyTheme(v); }
        ))
      )
    )
  );

  /* -- Data -- */
  const fileInput = el('input', {
    type: 'file', accept: 'application/json,.json', class: 'hidden-file',
    onChange: async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      const mode = await confirmDialog({
        title: 'Restore backup',
        message: 'Replace everything currently in the app with this backup? Choose Cancel to merge it in instead, keeping what you already have.',
        confirmLabel: 'Replace',
        destructive: true,
      });
      try {
        store.importBackup(text, mode ? 'replace' : 'merge');
        toast(mode ? 'Backup restored' : 'Backup merged in');
        rerender();
      } catch (err) {
        console.error(err);
        toast('That file could not be read', 'warn');
      }
      e.target.value = '';
    },
  });

  view.appendChild(
    el('section', {},
      el('h4', { class: 'section-title' }, 'Data'),
      card(
        row('Jobs', String(state.jobs.length)),
        row('Time entries', String(state.entries.length)),
        row('Invoices sent', String(state.invoices.length)),
        button('Export backup (JSON)', {
          variant: 'default', icon: 'download',
          onClick: () => {
            downloadFile(`hoursly-backup-${toDateInput(Date.now())}.json`, store.exportBackup(), 'application/json');
            toast('Backup downloaded');
          },
        }),
        button('Restore from backup', { variant: 'default', icon: 'upload', onClick: () => fileInput.click() }),
        fileInput,
        button('Erase everything', {
          variant: 'danger-ghost',
          onClick: async () => {
            const ok = await confirmDialog({
              title: 'Erase all data?',
              message: 'Every job, entry and setting is deleted from this device. Export a backup first if you might want it back.',
              confirmLabel: 'Erase',
              destructive: true,
            });
            if (ok) {
              store.resetAll();
              toast('Everything erased');
              navigate('#/jobs');
            }
          },
        })
      ),
      el('p', { class: 'hint' },
        'Everything stays on this device — nothing is uploaded. Back up regularly, ',
        'and before clearing your browser data.')
    )
  );

  if (state.invoices.length) {
    view.appendChild(
      el('section', {},
        el('h4', { class: 'section-title' }, 'Recent invoices'),
        card(state.invoices.slice(0, 8).map((inv) =>
          row(
            inv.id,
            `${inv.hours}h`,
            { sub: `${inv.client || 'No client'} · ${new Date(inv.issuedAt).toLocaleDateString()}` }
          )
        ))
      )
    );
  }

  view.appendChild(el('p', { class: 'footer-note' }, 'Hoursly · your hours, on your device'));
  return view;
}

/** Apply the saved theme to the document root. */
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}
