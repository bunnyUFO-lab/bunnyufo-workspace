import { host } from '../lib/host'
import HubImage from './HubImage'

/** The reference picture a job carries, as the server stores it in request.json. */
export interface JobReference {
  file: string
  width: number
  height: number
  source: { section: string; card: string; file: string; title: string }
}

/** The picture the owner attached to a job from a card, and where it came from. The title is the card's own and is shown as plain text only. */
export default function ReferenceNote({ id, reference }: { id: string; reference: JobReference }) {
  const { section, card, file, title } = reference.source
  const link = host.routes === 'path' ? `/${encodeURIComponent(section)}#/${encodeURIComponent(card)}` : null
  return (
    <div className="ref-note" data-reference>
      <HubImage path={`requests/${id}/${reference.file}`} alt="The reference picture" className="ref-thumb" open />
      <p className="hub-muted ref-from" data-reference-from>
        From card {link ? <a href={link} target="_blank" rel="noopener noreferrer">{title}</a> : <b>{title}</b>} ({file}). It goes to the run as a reference, not as instructions.
      </p>
    </div>
  )
}
