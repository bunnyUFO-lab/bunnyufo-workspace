/** What a chat's job row says about a job's state, in the words of the request page. */
export const JOB_STATE: Record<string, string> = {
  proposed: 'Waiting for you', approved: 'Approved, waiting to start', taken: 'Taken', running: 'Running', stopping: 'Stopping', stopped: 'Stopped',
  asking: 'Asking you', failed: 'Failed', lost: 'Lost', done: 'Done', declined: 'Declined', expired: 'Expired', open: 'Open',
}
/** A job in one of these is still going: the chat looks again every 20 s. */
export const LIVE_JOB = new Set(['approved', 'taken', 'running', 'stopping'])
export const jobTone = (state: string) => (LIVE_JOB.has(state) ? 'working' : state === 'proposed' || state === 'asking' ? 'needs' : state === 'done' ? 'done' : 'idle')
