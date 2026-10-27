import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { HubError } from '../lib/hub'
import { host } from '../lib/host'
import { authHeaders } from '../local/client'

const TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
const MAX_SECONDS = 120
const MAX_BYTES = 1.9 * 1024 * 1024
const TAP_MS = 300

/** Where it can work at all: the host turns speech into text, the page is a secure context, and the browser records. */
export const canRecord = () => host.transcribe && window.isSecureContext && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

async function transcribe(blob: Blob): Promise<string> {
  const response = await fetch('/api/hub/transcribe', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': blob.type || 'audio/webm' }, body: blob })
  const answer = await response.json().catch(() => null) as { text?: string; error?: string } | null
  if (response.status === 413) throw new HubError('That was longer than 2 minutes.', 413, null)
  if (!response.ok || typeof answer?.text !== 'string') throw new HubError(answer?.error ?? `Speech to text answered ${response.status}.`, response.status, null)
  return answer.text
}

/**
 * Hold to talk, or tap once to start and again to stop (a long press opens a menu on a phone, so
 * holding is unreliable there). The text is handed to `onText`; it is never sent by itself.
 */
export function usePushToTalk(onText: (text: string) => void) {
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const bytes = useRef(0)
  const startedAt = useRef(0)
  const tapMode = useRef(false)
  const pressed = useRef(false)
  const starting = useRef(false)
  const timer = useRef(0)
  const textRef = useRef(onText)
  useEffect(() => { textRef.current = onText })

  const release = () => {
    stream.current?.getTracks().forEach(track => track.stop())
    stream.current = null
    window.clearInterval(timer.current)
  }

  const stop = useCallback(() => {
    const active = recorder.current
    if (active && active.state !== 'inactive') active.stop()
  }, [])

  const start = useCallback(async () => {
    if (recorder.current || starting.current) return
    starting.current = true
    setError(null)
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.current = media
      const type = TYPES.find(candidate => MediaRecorder.isTypeSupported(candidate))
      const next = new MediaRecorder(media, type ? { mimeType: type } : undefined)
      recorder.current = next
      chunks.current = []
      bytes.current = 0
      next.ondataavailable = event => {
        if (!event.data.size) return
        chunks.current.push(event.data)
        bytes.current += event.data.size
        if (bytes.current > MAX_BYTES) stop()
      }
      next.onstop = () => {
        release()
        const blob = new Blob(chunks.current, { type: next.mimeType || type || 'audio/webm' })
        recorder.current = null
        setRecording(false)
        if (!blob.size) return
        setBusy(true)
        transcribe(blob)
          .then(text => { if (text.trim()) textRef.current(text.trim()) })
          .catch(failure => setError(failure instanceof Error ? failure.message : 'Speech to text failed.'))
          .finally(() => setBusy(false))
      }
      next.start(250)
      startedAt.current = Date.now()
      setSeconds(0)
      setRecording(true)
      timer.current = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAt.current) / 1000)
        setSeconds(elapsed)
        if (elapsed >= MAX_SECONDS) stop()
      }, 250)
      // Let go before the microphone was ready: that was a tap.
      if (!pressed.current) tapMode.current = true
    } catch (failure) {
      release()
      recorder.current = null
      const name = (failure as { name?: string }).name
      setError(name === 'NotAllowedError' || name === 'SecurityError' ? "Microphone blocked: allow it in the browser's site settings." : failure instanceof Error ? failure.message : 'The microphone could not be opened.')
    } finally {
      starting.current = false
    }
  }, [stop])

  useEffect(() => () => {
    release()
    const active = recorder.current
    if (active && active.state !== 'inactive') { active.onstop = null; active.stop() }
  }, [])

  const handlers = {
    onPointerDown: (event: ReactPointerEvent) => {
      event.preventDefault()
      pressed.current = true
      if (recorder.current && tapMode.current) { tapMode.current = false; stop(); return }
      tapMode.current = false
      void start()
    },
    onPointerUp: () => {
      pressed.current = false
      if (!recorder.current || tapMode.current) return
      if (Date.now() - startedAt.current < TAP_MS) tapMode.current = true
      else stop()
    },
    onPointerCancel: () => {
      pressed.current = false
      if (!recorder.current || tapMode.current) return
      if (Date.now() - startedAt.current < TAP_MS) tapMode.current = true
      else stop()
    },
    onContextMenu: (event: ReactMouseEvent) => event.preventDefault(),
  }
  return { recording, busy, seconds, error, handlers, stop }
}
