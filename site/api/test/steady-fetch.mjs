// Makes `fetch` steady on a PC that is busy with other work, for the tests only.
//
// Cause: on Windows, a connection to a test server on 127.0.0.1 now and then fails with
// ETIMEDOUT ("fetch failed") when the machine is loaded: several suites running at once, a
// build, a game. The connection was never made, so nothing reached the server, and the same
// request a moment later works. A failed connect is safe to repeat, even for a write, so this
// repeats it with a short pause. Any other error, and any answer from a server, passes
// through untouched. Imported by the fake S3, the fake Hermes and the UI tests' helpers;
// importing it twice does nothing.
//
// What is repeated, and for how long (ws-80u): a connect that TIMED OUT (ETIMEDOUT, undici's connect
// timeout), for up to 30 s, since on a loaded PC one repeat is not always enough. A refused connect
// (ECONNREFUSED) is repeated only in the first second after the test process started, while a fixture
// may still be coming up; after that it means the server is gone, so a crashed fixture fails at once.
// A reset (ECONNRESET) is never repeated: the request may have reached the server.
const real = globalThis.fetch;
export const STARTED_AT = Date.now();
export const REFUSED_WINDOW_MS = 1000;
const BUDGET_MS = 30_000;
export const isConnectFailure = code => code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT'
  || (code === 'ECONNREFUSED' && Date.now() - STARTED_AT < REFUSED_WINDOW_MS);

/** Runs `attempt()` again while it fails with a connect failure (by `codeOf(error)`) inside the budget. */
export async function repeatConnect(attempt, codeOf, { budgetMs = BUDGET_MS, aborted = () => false } = {}) {
  const end = Date.now() + budgetMs;
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (Date.now() > end || !isConnectFailure(codeOf(error)) || aborted()) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, 100 * tries)));
    }
  }
}

if (!real.steady) {
  const steady = (input, init) => repeatConnect(() => real(input, init), error => error?.cause?.code, { aborted: () => !!init?.signal?.aborted });
  steady.steady = true;
  globalThis.fetch = steady;
}
