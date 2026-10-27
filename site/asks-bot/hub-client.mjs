// The bot's way to the site API: two calls with the narrow bearer token, and one open read.
// `baseUrl` is the site API itself (in production the container name on the Docker network).
export function createHubClient({ baseUrl, token, fetchImpl = fetch, timeoutMs = 15_000 }) {
  const call = (method, route, { body, auth = true } = {}) => fetchImpl(`${baseUrl}${route}`, {
    method,
    headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const parse = async response => response.json().catch(() => null);
  return {
    /** The open Asks that may have buttons, each with its rev. Throws on anything but 200. */
    async listAsks() {
      const response = await call('GET', '/api/hub/discord/asks');
      if (!response.ok) throw new Error(`The Hub answered ${response.status} to the list.`);
      const body = await parse(response);
      if (!Array.isArray(body?.asks)) throw new Error('The Hub sent no list of Asks.');
      return body;
    },
    /** One Ask with its state and answer (a read the Hub leaves open); null when it is not there. */
    async getAsk(id) {
      const response = await call('GET', `/api/hub/asks/${encodeURIComponent(id)}`, { auth: false });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`The Hub answered ${response.status} to an Ask.`);
      return parse(response);
    },
    /** One click. Resolves { status, body } for any HTTP answer; a network error throws. */
    async answer(body) {
      const response = await call('POST', '/api/hub/discord/answer', { body });
      return { status: response.status, body: await parse(response) };
    },
  };
}
