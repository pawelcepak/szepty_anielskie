export async function api(path, opts = {}) {
  const r = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error || `Błąd ${r.status}`);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}
