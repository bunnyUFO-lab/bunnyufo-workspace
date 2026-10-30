// Runs that looked and found nothing to change end `outcome: failed` with one of these reasons. The dashboard reads
// them as done, not as a failure. The reason is free text an agent picks, so this is a list and not a pattern:
// `no-access` or `no-push-access` are real failures and stay alerts. The site API is the only reader; it tells the
// run drawer through `nothing` on the request detail, so the browser holds no copy of the list.
// (Cleaner later: a `nothing` outcome in `cards request finish`.)
export const NOTHING_TO_DO_REASONS = Object.freeze([
  'no-typo-found', 'no-change', 'no-changes', 'no-change-needed', 'no-changes-needed', 'nothing-to-change', 'nothing-to-do',
]);

/** True for a result that is `outcome: failed` with a reason on the list. */
export const nothingToDo = result => result?.outcome === 'failed' && typeof result.reason === 'string' && NOTHING_TO_DO_REASONS.includes(result.reason);
