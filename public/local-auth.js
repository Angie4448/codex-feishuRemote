// Bootstrap local browser authentication without putting secrets in requests.
// The launcher opens a loopback URL with a fragment, never a query parameter.
export function consumeLocalAuth(browser) {
  const location = browser.location;
  if (location.protocol !== 'http:' || location.hostname !== '127.0.0.1') return false;
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has('token')) return false;
  const token = params.get('token');
  // Remove even invalid fragments, and do it before touching storage.
  browser.history.replaceState(null, '', location.pathname + location.search);
  if (!/^[0-9a-f]{64}$/.test(token ?? '')) return false;
  browser.localStorage.setItem('comoteApiToken', token);
  return true;
}

if (typeof window !== 'undefined') {
  try { consumeLocalAuth(window); }
  catch { /* Storage may be blocked. The app's existing 401 message stays visible. */ }
}
