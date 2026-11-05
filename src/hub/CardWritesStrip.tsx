import { useEffect, useState } from 'react'
import Dialog from '../components/Dialog'
import { ago, remember } from '../lib/hub'
import { CardWriteRows } from './CardWrites'
import { useCardWrites, verb } from './cardWriteText'

const SEEN_KEY = 'buw:card-writes-note'

/**
 * One line above a card that an agent has written to, signed in on the Hub: who, what and when, and a way to open the rows. Nothing at
 * all for a card with no rows, so every other card looks as it did. The rows open as a bottom sheet on a phone, a dialog on a wide screen.
 */
export default function CardWritesStrip({ section, folder }: { section: string; folder: string }) {
  const { data } = useCardWrites(section, folder)
  const [open, setOpen] = useState(false)
  // The line about names and tokens shows the first time the sheet opens, then stays out of the way.
  const [seen, setSeen] = useState(() => remember(SEEN_KEY) === '1')
  useEffect(() => { if (open) remember(SEEN_KEY, '1') }, [open])
  const groups = data?.groups ?? []
  if (!groups.length) return null
  const latest = groups[0]
  return (
    <>
      <div className="cw-strip" data-cw-strip>
        <span className="cw-strip-text"><b>{latest.agent}</b> {verb(latest.title)}{latest.at ? ` · ${ago(latest.at)}` : ''}</span>
        <button type="button" className="cw-strip-btn" onClick={() => setOpen(true)} data-cw-history aria-haspopup="dialog">History ›</button>
      </div>
      {open && (
        <Dialog title="Agent writes to this card" onClose={() => { setOpen(false); setSeen(true) }} wide>
          {!seen && <p className="cw-note" data-cw-note>The name is what the agent says it is. The token is proven.</p>}
          <CardWriteRows section={section} groups={groups} />
          <p className="cw-foot"><button type="button" className="cw-btn" onClick={() => { setOpen(false); setSeen(true) }}>Close</button></p>
        </Dialog>
      )}
    </>
  )
}
