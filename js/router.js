/** Hash router. Routes look like `#/job/:id?query=1`. */

const routes = [];
let onChange = () => {};

export function defineRoute(pattern, handler) {
  const keys = [];
  const regex = new RegExp(
    `^${pattern
      .split('/')
      .map((part) => {
        if (part.startsWith(':')) {
          keys.push(part.slice(1));
          return '([^/]+)';
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/')}$`
  );
  routes.push({ regex, keys, handler });
}

export function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#/, '') || '/jobs';
  const [path, search] = raw.split('?');
  return { path: path || '/jobs', query: Object.fromEntries(new URLSearchParams(search || '')) };
}

export function resolve(hash = location.hash) {
  const { path, query } = parseHash(hash);
  for (const route of routes) {
    const match = route.regex.exec(path);
    if (match) {
      const params = {};
      route.keys.forEach((key, i) => { params[key] = decodeURIComponent(match[i + 1]); });
      return { handler: route.handler, params, query, path };
    }
  }
  return null;
}

export function navigate(hash, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', hash);
  else location.hash = hash;
  if (replace) onChange();
}

export function start(handler) {
  onChange = handler;
  window.addEventListener('hashchange', handler);
  handler();
}
