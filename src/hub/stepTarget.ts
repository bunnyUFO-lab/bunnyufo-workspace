import { useSyncExternalStore } from 'react'

/**
 * The step a paste goes to: the one the owner touched last. One per page, because the Needs you list shows several
 * checklist cards and only one may act. `step` is an item id, or "issue" for a playtest's issue row.
 */
export interface StepTarget { checklist: string; step: string }

let current: StepTarget | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(listener => listener())

export function setTarget(next: StepTarget) {
  if (current && current.checklist === next.checklist && current.step === next.step) return
  current = { ...next }
  emit()
}
export const getTarget = (): StepTarget | null => current
export function clearTarget(checklist: string) {
  if (current?.checklist !== checklist) return
  current = null
  emit()
}
/** The target, and a re-render when it moves. */
export function useTarget(): StepTarget | null {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, getTarget)
}
