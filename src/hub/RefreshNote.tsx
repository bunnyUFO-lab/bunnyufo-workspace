import { clock } from '../lib/hub'

/**
 * The line under a Hub screen's heading when its read failed. With no data it is the red error. With data
 * on screen (the last answer, kept) it is one quiet line, so a failed refresh never blanks good data.
 */
export default function RefreshNote({ error, hasData, at }: { error: string | null; hasData: boolean; at: Date | null }) {
  if (!error) return null
  if (!hasData) return <p className="hub-error" role="alert">{error}</p>
  return <p className="hub-muted hub-stale" role="status" data-hub-stale>Could not refresh. Showing what came at {at ? clock(at.toISOString()) : 'the last answer'}.</p>
}
