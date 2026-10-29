import { hubHash } from '../lib/route'
import type { Handoff } from './flash'

/**
 * The note after an item is settled: what was done, what is next, and a way back to the settled item. It stays until the
 * next action or a navigation, so a slow reader on a phone is never rushed.
 */
export default function NextNote({ note }: { note: Handoff }) {
  return (
    <div className="nq-next" role="status" data-next-note>
      <span className="nq-next-text">
        <b className="nq-next-v">{note.verb}{note.next ? '' : '.'}</b>
        {note.next ? <span className="nq-next-n"><span aria-hidden="true"> · </span>next: <i>{note.next}</i></span> : null}
        {note.nothingLeft ? <span className="nq-next-n"> Nothing else waits on you.</span> : null}
        {!note.next && !note.nothingLeft && note.elsewhere ? (
          <span className="nq-next-n nq-next-else"> {note.kindPlural ? `No more ${note.kindPlural}. ` : ''}<a href={hubHash('needs')} data-next-all>{note.elsewhere} more wait in All →</a></span>
        ) : null}
      </span>
      <a className="nq-next-back" href={note.backHash} data-next-back>Back</a>
    </div>
  )
}
