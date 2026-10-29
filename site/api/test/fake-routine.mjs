// A stand-in for a Claude Code routine's Fire URL, as a `fetch` replacement for the site API.
//   const routine = createFakeRoutine({ status: 200 });
//   createHub({ fetchImpl: routine.fetchImpl, … });  routine.calls: [{ url, headers, body }]
// Options (change them at any time with `routine.set({...})`):
//   status    the HTTP status to answer (default 200)
//   fail      true: the call fails like a network error
//   delayMs   how long to hold the answer (an abort signal ends it, as a real timeout does)
//   body      the answer's JSON; the default has the keys the real routine answers with (S3)
export function createFakeRoutine(options = {}) {
  const state = { status: 200, fail: false, delayMs: 0, body: null, ...options };
  const calls = [];
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
  async function fetchImpl(url, init = {}) {
    calls.push({ url: String(url), method: init.method, headers: { ...init.headers }, body: init.body });
    if (state.fail) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (state.delayMs) await sleep(state.delayMs, init.signal);
    const body = state.body ?? { type: 'routine_fire', claude_code_session_id: `session_fake${calls.length}`, claude_code_session_url: `https://claude.ai/code/session_fake${calls.length}` };
    return new Response(JSON.stringify(body), { status: state.status, headers: { 'Content-Type': 'application/json' } });
  }
  return { fetchImpl, calls, set: next => Object.assign(state, next) };
}
