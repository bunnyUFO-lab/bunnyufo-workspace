// A run's life as events: `run-started` when a request was taken and `run-finished` when its result was written.
// They are made at read time from the request list (taken.json and result.json are the truth, whoever wrote them:
// the dispatch script, a cloud routine or the site API for Hermes), so no runner has to post them and nothing is
// written to the Inbox. They join the event window that Since yesterday and Activity read.
import { WINDOW_DAYS, DAY } from './hub-model.mjs';

const WHERE = { hermes: 'Hermes', cloud: 'the cloud', pc: 'the PC' };
const OUTCOME_WORD = { pr: 'opened a pull request', card: 'wrote a card', failed: 'failed', question: 'asked a question', unknown: 'ended, outcome unknown' };

/**
 * @param requests   request list rows (`requestItem`), which carry `run` and `finish`
 * @param cardHref   `(card) => string | undefined`: the site path of a `section/folder` card, when known
 * @returns events (not sorted) in the shape of the event files, plus `request` and `outcome`
 */
export function runEvents(requests, { now, cardHref = () => undefined } = {}) {
  const floor = now.getTime() - WINDOW_DAYS * DAY;
  const out = [];
  for (const item of requests) {
    if (!item.run && !item.finish) continue;
    const base = { project: item.project, host: item.run?.runner ?? item.target ?? '', source: 'request', request: item.id };
    if (item.run && new Date(item.run.at).getTime() >= floor) {
      out.push({ ...base, ts: item.run.at, kind: 'run-started', file: `run-${item.id}-started.json`, title: `Started${WHERE[item.run.runner] ? ` on ${WHERE[item.run.runner]}` : ''}: ${item.title}` });
    }
    if (item.finish && new Date(item.finish.at).getTime() >= floor) {
      const { outcome, pr, card } = item.finish;
      const href = card ? cardHref(card) : undefined;
      out.push({
        ...base, ts: item.finish.at, kind: 'run-finished', file: `run-${item.id}-finished.json`, outcome,
        title: `${outcome === 'failed' ? 'Failed' : 'Finished'}: ${item.title}`,
        summary: `The run ${OUTCOME_WORD[outcome] ?? 'ended'}`,
        ...(pr ? { url: pr } : {}), ...(href ? { cardHref: href } : {}),
      });
    }
  }
  return out;
}

/** The event window with the runs' events in it, newest first like `loadEvents`. */
export function withRunEvents(events, requests, opts) {
  const have = new Set(events.map(event => event.file));
  const extra = runEvents(requests, opts).filter(event => !have.has(event.file));
  return extra.length ? [...events, ...extra].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : a.file < b.file ? 1 : -1)) : events;
}
