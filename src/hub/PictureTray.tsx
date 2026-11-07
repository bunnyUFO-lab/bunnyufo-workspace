import { useRef } from 'react'
import { Icon } from '../local/Icons'
import HubImage from './HubImage'
import { PICTURE_TYPES } from './chatImages'
import type { Pictures } from './pictures'

/**
 * The attach button of a text box: chat's round 44 px button and its hidden picker. No `capture` and explicit types
 * (PICTURE_TYPES), so a phone offers its photo library, the camera and files. `reason` switches it off and says why.
 */
export function PictureButton({ pictures, multiple = true, disabled = false, reason, label = 'Attach pictures' }: { pictures: Pictures; multiple?: boolean; disabled?: boolean; reason?: string; label?: string }) {
  const picker = useRef<HTMLInputElement>(null)
  return (
    <>
      <input ref={picker} type="file" accept={PICTURE_TYPES} multiple={multiple} hidden data-attach-input onChange={event => { void pictures.add(Array.from(event.target.files ?? [])); event.target.value = '' }} />
      <button type="button" className="hub-attach" aria-label={label} title={reason ?? label} disabled={disabled || !!reason} data-attach onClick={() => picker.current?.click()}><Icon name="attach" size={20} /></button>
    </>
  )
}

/** The tiles under a text box: each picture with its ×, a Retry on one that did not save, and the line that says what went wrong. */
export function PictureTray({ pictures, show = true }: { pictures: Pictures; show?: boolean }) {
  const { items, preparing, note, uploading } = pictures
  if (!show || (items.length === 0 && preparing === 0 && !note)) return null
  return (
    <div className="hub-tray" data-tray>
      {items.map((picture, index) => (
        <div className={`hub-tray-item${picture.state === 'failed' ? ' failed' : ''}`} key={picture.id} data-state={picture.state}>
          {picture.url ? <img src={picture.url} alt={`Picture ${index + 1}`} /> : <HubImage path={picture.path} alt={`Picture ${index + 1}`} />}
          {picture.state === 'failed' && <button type="button" className="hub-btn hub-tray-retry" data-retry onClick={() => pictures.retry(picture)}>Retry</button>}
          <button type="button" className="hub-tray-remove" aria-label={`Remove picture ${index + 1}`} onClick={() => pictures.remove(picture)}><span aria-hidden="true">×</span></button>
        </div>
      ))}
      {preparing > 0 && <span className="hub-muted hub-tray-note" role="status">Preparing {preparing === 1 ? 'a picture' : `${preparing} pictures`}…</span>}
      {uploading && preparing === 0 && <span className="hub-muted hub-tray-note" role="status" data-saving>Saving a picture…</span>}
      {items.filter(item => item.error).map(item => <span key={item.id} className="hub-tray-note hub-tray-warn" role="status">{item.error}</span>)}
      {note && <span className="hub-tray-note hub-tray-warn" role="status">{note}</span>}
    </div>
  )
}
