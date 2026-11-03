/** True when the review's `ask` says there is nothing else for the owner to do ("Nothing to do: Mark done"). */
export const nothingToDo = (ask?: string): boolean => !!ask && /(?:^|[^\w])nothing\s+(?:else\s+)?to\s+do|(?:^|[^\w])no\s+action/i.test(ask)

export const DONE_HINT = "Hides this from Needs you. It doesn't merge or approve anything."
