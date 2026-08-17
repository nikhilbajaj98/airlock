// Thin authenticated wrapper over fetch for the Bright Data API.
//
// Every Airlock call to Bright Data goes through here, so auth and error-body
// handling live in exactly one place. Callers get the raw status back and decide
// what it means — a 202 is "still working" on some endpoints and an error on
// others, so this layer deliberately does not treat non-2xx as fatal.

import { API_BASE, requireApiKey } from './config.js';

export async function apiRequest(method, path, options = {}) {
  const { body, query } = options;

  const url = new URL(path, API_BASE);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const headers = { Authorization: `Bearer ${requireApiKey()}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();

  // Error bodies are not always JSON, so a parse failure is not itself an error.
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  return { status: response.status, ok: response.ok, text, data };
}

export const apiGet = (path, options) => apiRequest('GET', path, options);

export const apiPost = (path, body, options = {}) =>
  apiRequest('POST', path, { ...options, body });
