export async function api<T>(
  url: string,
  options: RequestInit = {},
  csrfToken?: string,
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (csrfToken) headers.set('X-CSRF-Token', csrfToken);

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: 'same-origin',
  });
  const payload = await response.json().catch(() => ({})) as {
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `Հարցումը ձախողվեց (${response.status})`);
  }
  return payload as T;
}
