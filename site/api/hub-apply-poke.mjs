// Tells the Action that applies the owner's plans and marks that there is work, so an approval on a phone reaches Beads with no PC on.
// It sends no data: the run reads what is pending itself. Off unless HUB_APPLY_DISPATCH_TOKEN and HUB_APPLY_DISPATCH_REPO are in api.env,
// and then an approval changes nothing but this one request. A failed poke only costs time: the Action also runs on a schedule.

/** Several marks in a row make one run. */
export const APPLY_POKE_DELAY_MS = 15_000;

const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** `createApplyPoke({ env, fetchImpl, log })` → `{ on, poke() }`. `poke` never throws and never waits. */
export function createApplyPoke({ env = {}, fetchImpl = fetch, log = () => {}, setTimer = setTimeout } = {}) {
  const token = String(env.HUB_APPLY_DISPATCH_TOKEN ?? '').trim();
  const repo = String(env.HUB_APPLY_DISPATCH_REPO ?? '').trim();
  const on = !!token && REPO.test(repo);
  const delay = Number(env.HUB_APPLY_DISPATCH_DELAY_MS) || APPLY_POKE_DELAY_MS;
  let waiting = false;
  const send = async () => {
    waiting = false;
    try {
      const answer = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/apply.yml/dispatches`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'bunnyufo-hub', 'X-GitHub-Api-Version': '2022-11-28' },
        body: JSON.stringify({ ref: 'main' }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!answer.ok) log(`[hub] apply poke: GitHub answered ${answer.status}`);
    } catch (error) {
      log(`[hub] apply poke failed: ${error?.name ?? 'error'}`);
    }
  };
  return {
    on,
    poke() {
      if (!on || waiting) return;
      waiting = true;
      setTimer(send, delay)?.unref?.();
    },
  };
}
