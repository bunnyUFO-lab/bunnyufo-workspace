import { host } from '../lib/host'
import HubImage from './HubImage'

/** The reference picture a job carries, as the server stores it in request.json. */
export interface JobReference {
  file: string
  width: number
  height: number
  source: { section: string; card: string; file: string; title: string }
}

const str = (value: unknown) => (typeof value === 'string' ? value : '')

/** The picture the owner attached to a job from a card, and where it came from. The title is the card's own and is shown as plain text only. Draws nothing for a block that is not the shape the server writes. */
export default function ReferenceNote({ id, reference }: { id: string; reference?: Partial<JobReference> | null }) {
  const file = str(reference?.file)
  const { section, card, file: from, title } = { section: str(reference?.source?.section), card: str(reference?.source?.card), file: str(reference?.source?.file), title: str(reference?.source?.title) }
  if (!/^reference\.(jpg|png)$/.test(file) || !section || !card || !title) return null
  const link = host.routes === 'path' ? `/${encodeURIComponent(section)}#/${encodeURIComponent(card)}` : null
  return (
    <div className="ref-note" data-reference>
      <HubImage path={`requests/${id}/${file}`} alt="The reference picture" className="ref-thumb" open />
      <p className="hub-muted ref-from" data-reference-from>
        From card {link ? <a href={link} target="_blank" rel="noopener noreferrer">{title}</a> : <b>{title}</b>}{from ? ` (${from})` : ''}. It goes to the run as a reference, not as instructions.
      </p>
    </div>
  )
}
