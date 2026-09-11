/**
 * Minimal DOM toolkit: a hyperscript helper, bottom sheets, dialogs and toasts.
 * Deliberately tiny — the app is small enough that a framework would cost more
 * than it saves, and this keeps the whole thing dependency-free.
 */

import { pad } from './calc.js';

/* ------------------------------------------------------------------ *
 * Elements
 * ------------------------------------------------------------------ */

/**
 * Create an element. `props` handles class/dataset/style/events/attributes.
 * Children may be nodes, strings, arrays, or null (skipped).
 */
export function el(tag, props = null, ...children) {
  const node = document.createElement(tag);

  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'style' && typeof value === 'object') setStyle(node, value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'html') node.innerHTML = value;
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in node && key !== 'list' && typeof value !== 'object') {
        node[key] = value;
      } else {
        node.setAttribute(key, value === true ? '' : value);
      }
    }
  }

  append(node, children);
  return node;
}

/**
 * Apply inline styles. Custom properties have to go through setProperty —
 * assigning `style['--x']` is silently ignored.
 */
function setStyle(node, styles) {
  for (const [prop, value] of Object.entries(styles)) {
    if (prop.startsWith('--')) node.style.setProperty(prop, value);
    else node.style[prop] = value;
  }
}

function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/**
 * Empty a node in one step. `replaceChildren` is atomic, so a blur handler
 * firing as a focused child is removed can't race a half-finished loop.
 */
export function clear(node) {
  node.replaceChildren();
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** An inline SVG icon from the sprite in index.html. */
export function icon(name, size = 20) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

/* ------------------------------------------------------------------ *
 * Rows and common building blocks
 * ------------------------------------------------------------------ */

export function card(...children) {
  return el('div', { class: 'card' }, children);
}

/** A settings-style row: label on the left, value (and chevron) on the right. */
export function row(label, value, opts = {}) {
  const { onClick, chevron = !!onClick, danger = false, sub = null } = opts;
  const node = el(
    onClick ? 'button' : 'div',
    {
      class: `row${danger ? ' row-danger' : ''}${onClick ? ' row-tappable' : ''}`,
      type: onClick ? 'button' : null,
      onClick,
    },
    el('span', { class: 'row-label' }, label, sub ? el('small', {}, sub) : null),
    el('span', { class: 'row-value' }, value ?? ''),
    chevron ? icon('chevron', 16) : null
  );
  return node;
}

export function button(label, opts = {}) {
  const { variant = 'default', onClick, icon: iconName, type = 'button', disabled } = opts;
  return el(
    'button',
    { class: `btn btn-${variant}`, type, onClick, disabled: disabled || null },
    iconName ? icon(iconName, 18) : null,
    el('span', {}, label)
  );
}

export function field(label, input, hint) {
  return el(
    'label',
    { class: 'field' },
    el('span', { class: 'field-label' }, label),
    input,
    hint ? el('small', { class: 'field-hint' }, hint) : null
  );
}

export function select(options, value, onChange) {
  const node = el(
    'select',
    { class: 'input', onChange: (e) => onChange(e.target.value) },
    options.map(([v, label]) => el('option', { value: v, selected: String(v) === String(value) }, label))
  );
  node.value = value;
  return node;
}

export function segmented(options, value, onChange) {
  return el(
    'div',
    { class: 'segmented', role: 'tablist' },
    options.map(([v, label]) =>
      el(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: `seg${String(v) === String(value) ? ' seg-on' : ''}`,
          'aria-selected': String(v) === String(value),
          onClick: () => onChange(v),
        },
        label
      )
    )
  );
}

export function toggle(checked, onChange) {
  return el('label', { class: 'switch' },
    el('input', { type: 'checkbox', checked: checked || null, onChange: (e) => onChange(e.target.checked) }),
    el('span', { class: 'switch-track' }, el('span', { class: 'switch-thumb' }))
  );
}

export function emptyState(title, message, action) {
  return el('div', { class: 'empty' },
    el('h3', {}, title),
    el('p', {}, message),
    action || null
  );
}

/* ------------------------------------------------------------------ *
 * Sheets and dialogs
 * ------------------------------------------------------------------ */

let openSheets = 0;

/**
 * A bottom sheet. `render(api)` returns the body; `api.close(result)` resolves
 * the returned promise.
 */
export function sheet({ title, subtitle, render, onConfirm, confirmLabel = 'Save', fullHeight = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      backdrop.classList.remove('in');
      document.removeEventListener('keydown', onKey);
      openSheets = Math.max(0, openSheets - 1);
      if (!openSheets) document.body.classList.remove('sheet-open');
      setTimeout(() => backdrop.remove(), 220);
      resolve(value);
    };

    const api = { close: finish };

    const onKey = (e) => {
      if (e.key === 'Escape') finish(undefined);
    };

    const body = el('div', { class: 'sheet-body' });
    const panel = el(
      'div',
      { class: `sheet${fullHeight ? ' sheet-full' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' },
      el('div', { class: 'sheet-grab' }),
      el('div', { class: 'sheet-head' },
        el('button', { class: 'sheet-x', type: 'button', 'aria-label': 'Close', onClick: () => finish(undefined) }, icon('close', 18)),
        el('div', { class: 'sheet-title' },
          el('strong', {}, title || ''),
          subtitle ? el('small', {}, subtitle) : null
        ),
        onConfirm
          ? el('button', {
              class: 'sheet-ok', type: 'button', 'aria-label': confirmLabel,
              onClick: async () => {
                const result = await onConfirm(api);
                if (result !== false) finish(result === undefined ? true : result);
              },
            }, icon('check', 20))
          : el('span', { class: 'sheet-x sheet-x-ghost' })
      ),
      body
    );

    const backdrop = el('div', { class: 'backdrop', onClick: (e) => { if (e.target === backdrop) finish(undefined); } }, panel);

    append(body, [render(api)]);
    document.body.appendChild(backdrop);
    document.body.classList.add('sheet-open');
    openSheets += 1;
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => backdrop.classList.add('in'));

    const focusTarget = panel.querySelector('input, select, textarea, button.btn');
    if (focusTarget && !('ontouchstart' in window)) setTimeout(() => focusTarget.focus(), 250);
  });
}

/** A yes/no dialog. Resolves to true only if the user confirms. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', destructive = false }) {
  return new Promise((resolve) => {
    const finish = (value) => {
      backdrop.classList.remove('in');
      setTimeout(() => backdrop.remove(), 200);
      resolve(value);
    };
    const panel = el('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true' },
      el('h3', {}, title),
      message ? el('p', {}, message) : null,
      el('div', { class: 'dialog-actions' },
        button('Cancel', { variant: 'ghost', onClick: () => finish(false) }),
        button(confirmLabel, { variant: destructive ? 'danger' : 'primary', onClick: () => finish(true) })
      )
    );
    const backdrop = el('div', { class: 'backdrop backdrop-center', onClick: (e) => { if (e.target === backdrop) finish(false); } }, panel);
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('in'));
  });
}

/** A menu of choices anchored to the bottom of the screen. */
export function actionSheet(title, actions) {
  return new Promise((resolve) => {
    const finish = (value) => {
      backdrop.classList.remove('in');
      setTimeout(() => backdrop.remove(), 200);
      resolve(value);
    };
    const panel = el('div', { class: 'action-sheet' },
      title ? el('div', { class: 'action-title' }, title) : null,
      el('div', { class: 'action-list' },
        actions.map((a) =>
          el('button', {
            class: `action${a.destructive ? ' action-danger' : ''}`,
            type: 'button',
            onClick: () => finish(a.value),
          }, a.icon ? icon(a.icon, 18) : null, el('span', {}, a.label))
        )
      ),
      el('button', { class: 'action action-cancel', type: 'button', onClick: () => finish(null) }, 'Cancel')
    );
    const backdrop = el('div', { class: 'backdrop backdrop-actions', onClick: (e) => { if (e.target === backdrop) finish(null); } }, panel);
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('in'));
  });
}

let toastTimer = null;
export function toast(message, variant = '') {
  let node = $('#toast');
  if (!node) {
    node = el('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(node);
  }
  node.className = `toast ${variant}`.trim();
  node.textContent = message;
  requestAnimationFrame(() => node.classList.add('in'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('in'), 2600);
}

/* ------------------------------------------------------------------ *
 * datetime-local helpers
 * ------------------------------------------------------------------ */

/** epoch ms → the `YYYY-MM-DDTHH:MM` string a datetime-local input expects. */
export function toLocalInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The inverse: a local input string → epoch ms (NaN if incomplete). */
export function fromLocalInput(value) {
  if (!value) return NaN;
  const [date, time] = value.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  return new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0).getTime();
}

/** `YYYY-MM-DD` → epoch ms at local midnight. */
export function fromDateInput(value) {
  if (!value) return NaN;
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

export function toDateInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Today" / "Yesterday" / "Mon Sep 07" — the way a human scans a list. */
export function friendlyDay(ms) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(ms);
  target.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today - target) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  const opts = { weekday: 'short', month: 'short', day: '2-digit' };
  if (target.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return new Date(ms).toLocaleDateString(undefined, opts);
}

export function timeLabel(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
