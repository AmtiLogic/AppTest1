/** App shell: header, tab bar, routing, the live timer and the running banner. */

import * as store from './store.js';
import { el, clear, icon, toast, timeLabel } from './ui.js';
import { defineRoute, resolve, navigate, start, parseHash } from './router.js';
import { entryMetrics, formatStopwatch, round } from './calc.js';
import { jobsView, jobDetailView } from './views/jobs.js';
import { entriesView } from './views/entries.js';
import { reportsView } from './views/reports.js';
import { sendView, resetSendDraft } from './views/send.js';
import { settingsView, applyTheme } from './views/settings.js';

const TABS = [
  { hash: '#/jobs', label: 'Jobs', icon: 'jobs', match: (p) => p.startsWith('/job') },
  { hash: '#/entries', label: 'Entries', icon: 'clock', match: (p) => p.startsWith('/entries') },
  { hash: '#/periods', label: 'Pay Periods', icon: 'wallet', match: (p) => p.startsWith('/periods') },
  { hash: '#/settings', label: 'More', icon: 'more', match: (p) => p.startsWith('/settings') || p.startsWith('/send') },
];

const header = el('header', { class: 'topbar' });
const main = el('main', { class: 'main', id: 'main' });
const banner = el('div', { class: 'banner', hidden: true });
const tabbar = el('nav', { class: 'tabbar', 'aria-label': 'Sections' });

let currentPath = '';

/* ------------------------------------------------------------------ *
 * Header
 * ------------------------------------------------------------------ */

function setHeader({ title, back, actions = [], onTitleClick }) {
  clear(header);
  header.appendChild(
    back
      ? el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back', onClick: () => navigate(back) }, icon('back', 20))
      : el('span', { class: 'icon-btn icon-btn-ghost' })
  );
  header.appendChild(
    onTitleClick
      ? el('button', { class: 'topbar-title topbar-title-tappable', type: 'button', onClick: onTitleClick }, title)
      : el('h1', { class: 'topbar-title' }, title)
  );
  header.appendChild(
    el('div', { class: 'topbar-actions' },
      actions.map((a) =>
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': a.label, title: a.label, onClick: a.onClick },
          icon(a.icon, 20))
      )
    )
  );
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

defineRoute('/jobs', jobsView);
defineRoute('/job/:id', jobDetailView);
defineRoute('/entries', entriesView);
defineRoute('/periods', reportsView);
defineRoute('/send', sendView);
defineRoute('/settings', settingsView);

/**
 * Render the current route. Guarded against re-entry: tearing down the old
 * view blurs whatever was focused, and a blur handler that renders again would
 * otherwise interleave with this one. A nested call just asks for one more
 * pass once this one has finished.
 */
let rendering = false;
let renderQueued = false;
function render() {
  if (rendering) {
    renderQueued = true;
    return;
  }
  rendering = true;
  try {
    renderRoute();
  } finally {
    rendering = false;
  }
  if (renderQueued) {
    renderQueued = false;
    render();
  }
}

function renderRoute() {
  const match = resolve() || resolve('#/jobs');
  const { path } = parseHash();

  // Leaving the send flow discards its in-progress draft.
  if (currentPath.startsWith('/send') && !path.startsWith('/send')) resetSendDraft();
  const changedView = currentPath !== path;
  currentPath = path;

  const view = match.handler({
    params: match.params,
    query: match.query,
    setHeader,
    rerender: render,
  });

  clear(main);
  main.appendChild(view);
  if (changedView) main.scrollTop = 0;

  renderTabs(path);
  renderBanner();
  tick();
}

/**
 * Re-render after a state change — but not out from under a field the user is
 * still typing in. Settings save on every keystroke, and rebuilding the view
 * mid-word would drop focus and the caret. The banner still updates live.
 */
let deferredRender = false;
function scheduleRender() {
  const active = document.activeElement;
  const typing = active && main.contains(active) && /^(INPUT|TEXTAREA)$/.test(active.tagName);
  if (typing) {
    renderBanner();
    if (!deferredRender) {
      deferredRender = true;
      active.addEventListener('blur', () => {
        deferredRender = false;
        // If the field is gone, a render already replaced this view.
        if (active.isConnected) render();
      }, { once: true });
    }
    return;
  }
  render();
}

function renderTabs(path) {
  clear(tabbar);
  for (const tab of TABS) {
    const active = tab.match(path);
    tabbar.appendChild(
      el('a', {
        class: `tab${active ? ' tab-on' : ''}`,
        href: tab.hash,
        'aria-current': active ? 'page' : null,
      }, icon(tab.icon, 22), el('span', {}, tab.label))
    );
  }
}

/* ------------------------------------------------------------------ *
 * Running-shift banner — visible from anywhere in the app
 * ------------------------------------------------------------------ */

function renderBanner() {
  const running = store.runningEntry();
  if (!running) {
    banner.hidden = true;
    clear(banner);
    return;
  }
  const job = store.getJob(running.jobId);
  const metrics = entryMetrics(running, job);

  clear(banner);
  banner.hidden = false;
  banner.appendChild(
    el('button', {
      class: 'banner-main', type: 'button', onClick: () => navigate(`#/job/${running.jobId}`),
    },
      el('span', { class: 'pulse', style: { background: job?.color || '#34c759' } }),
      el('span', { class: 'banner-text' },
        el('strong', {}, job?.name || 'On the clock'),
        el('small', {}, `since ${timeLabel(new Date(running.start).getTime())}`)
      ),
      el('span', { class: 'banner-time', dataset: { tick: running.id } }, formatStopwatch(metrics.elapsed))
    )
  );
  banner.appendChild(
    el('button', {
      class: 'banner-stop', type: 'button',
      onClick: () => { store.clockOut(running.id); toast('Clocked out'); },
    }, 'Stop')
  );
}

/* ------------------------------------------------------------------ *
 * The ticking clock
 * ------------------------------------------------------------------ */

/**
 * Update every element tagged `data-tick="<entryId>"` in place. Re-rendering
 * the whole view once a second would fight with anything the user is typing.
 */
function tick() {
  const running = store.runningEntry();
  if (!running) return;
  const job = store.getJob(running.jobId);
  const metrics = entryMetrics(running, job);
  for (const node of document.querySelectorAll(`[data-tick="${running.id}"]`)) {
    node.textContent = node.dataset.ticktype === 'hours'
      ? `${round(metrics.hours, 2)}h`
      : formatStopwatch(metrics.elapsed);
  }
}

setInterval(tick, 1000);

// A phone that slept for an hour needs the banner and totals refreshed, not
// just the seconds nudged along.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) render();
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

function boot() {
  const app = el('div', { class: 'app' }, header, banner, main, tabbar);
  document.body.appendChild(app);

  applyTheme(store.getState().settings.theme);

  store.onStorageError(() => {
    toast('Could not save — storage may be full or private browsing is on', 'warn');
  });

  store.subscribe(scheduleRender);

  start(render);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* Offline support is a bonus; the app works fine without it. */
    });
  }
}

boot();
