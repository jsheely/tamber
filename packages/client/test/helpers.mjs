// Test helpers: a fake fetch returning a streamed body split at arbitrary byte boundaries.
export function streamOf(bytes, chunkSize = 7) {
  let pos = 0;
  let cancelled = false;
  return {
    cancelled: () => cancelled,
    getReader() {
      return {
        async read() {
          if (cancelled || pos >= bytes.length) return { done: true, value: undefined };
          const value = bytes.slice(pos, pos + chunkSize);
          pos += chunkSize;
          return { done: false, value };
        },
        async cancel() {
          cancelled = true;
        },
        releaseLock() {},
      };
    },
  };
}

export function fakeResponse({
  status = 200,
  headers = {},
  body = '',
  stream = true,
  chunkSize = 7,
}) {
  const bytes = new TextEncoder().encode(body);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    headers: { get: (n) => lower[n.toLowerCase()] ?? null },
    body: stream ? streamOf(bytes, chunkSize) : null,
    async text() {
      return body;
    },
    async arrayBuffer() {
      return bytes.buffer;
    },
  };
}

export function recordingFetch(respond) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  fn.calls = calls;
  return fn;
}
