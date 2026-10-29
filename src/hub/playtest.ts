import { useState } from 'react'
import type { PlaytestIssue, PlaytestVerdict } from '../lib/hub'
import { HubError, hubPost } from '../lib/hub'
import { host } from '../lib/host'
import { prepareImage, toBase64 } from './chatImages'

export const VERDICT_LABEL: [PlaytestVerdict, string][] = [['ship', 'Ship it'], ['fix-first', 'Fix first'], ['rethink', 'Rethink']]
export const MAX_ISSUES = 30

/** What the owner is writing in a playtest: a rating, issues (each with a screenshot if they like) and a verdict. Held until Send report. */
export function usePlaytestReport(checklistId: string, live: boolean, reload: () => void) {
  const [rating, setRating] = useState(0)
  const [verdict, setVerdict] = useState<PlaytestVerdict | null>(null)
  const [issues, setIssues] = useState<PlaytestIssue[]>([])
  const [draft, setDraft] = useState('')
  const [shot, setShot] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function attach(file: File | undefined) {
    if (!file || !live || uploading || !host.write) return
    setUploading(true)
    setProblem(null)
    try {
      const picture = await prepareImage(file)
      try {
        const stored = await hubPost<{ file: string }>(`/checklists/${encodeURIComponent(checklistId)}/files`, { for: 'issue', image: { type: picture.type, data: await toBase64(picture.blob) } })
        setShot(stored.file)
      } finally {
        URL.revokeObjectURL(picture.url)
      }
    } catch (failure) {
      if (failure instanceof HubError && failure.status === 409) reload()
      setProblem(failure instanceof Error ? failure.message : 'That picture did not save.')
    } finally {
      setUploading(false)
    }
  }
  function add() {
    const text = draft.trim()
    if (!text || issues.length >= MAX_ISSUES) return
    setIssues(previous => [...previous, { text, ...(shot ? { shot } : {}) }])
    setDraft('')
    setShot(null)
  }
  return {
    rating, setRating, verdict, setVerdict, issues, draft, setDraft, shot, setShot, uploading, problem, attach, add,
    remove: (index: number) => setIssues(previous => previous.filter((_, at) => at !== index)),
    ready: rating >= 1 && !!verdict,
    // An issue typed but not added yet still goes with the report.
    payload: () => ({ rating, verdict, issues: draft.trim() ? [...issues, { text: draft.trim(), ...(shot ? { shot } : {}) }] : issues }),
  }
}

