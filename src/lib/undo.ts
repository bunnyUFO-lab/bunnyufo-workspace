export interface Toast { id: number; message: string; undo?: () => Promise<unknown> | void }

let current: Toast | null = null
let counter = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(listener => listener())
export const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

/** Show "<message> · Undo" for eight seconds. One at a time: a new one replaces the old. */
export function showUndo(message: string, undo?: () => Promise<unknown> | void) {
  counter += 1
  current = { id: counter, message, undo }
  emit()
}

export const dismiss = (id: number) => { if (current?.id === id) { current = null; emit() } }
export const getToast = () => current
