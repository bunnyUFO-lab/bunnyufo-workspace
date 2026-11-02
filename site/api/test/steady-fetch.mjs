// Makes `fetch` steady on a PC that is busy with other work, for the tests only.
//
// Cause: on Windows, a connection to a test server on 127.0.0.1 now and then fails with
// ETIMEDOUT ("fetch failed") when the machine is loaded: several suites running at once, a
// build, a game. The connection was never made, so nothing reached the server, and the same
// request a moment later works. A failed connect is safe to repeat, even for a write, so this
// repeats it with a short pause. Any other error, and any answer from a server, passes
// through untouched. Imported by the fake S3, the fake Hermes and the UI tests' helpers;
// importing it twice does nothing.
const real = globalThis.fetch;
const CONNECT_FAILURES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);
const TRIES = 8;

if (!real.steady) {
  const steady = async (input, init) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await real(input, init);
      } catch (error) {
        if (attempt >= TRIES || !CONNECT_FAILURES.has(error?.cause?.code) || init?.signal?.aborted) throw error;
        await new Promise(resolve => setTimeout(resolve, 100 * attempt));
      }
    }
  };
  steady.steady = true;
  globalThis.fetch = steady;
}
