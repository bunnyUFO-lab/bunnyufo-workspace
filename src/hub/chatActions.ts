// What the owner can do to a chat from the list or from its own page. Nothing here deletes anything: Delete sets the Trash mark and
// the transcript stays (POST /hub/chat/<id>/state). Each action says so with a toast, and the Undo is one more state write.
import type { MenuItem } from '../components/ItemMenu'
import type { ChatMarks, ChatPatch, ChatSummary } from '../lib/hub'
import { hubPost } from '../lib/hub'
import { showUndo } from '../lib/undo'
import { host } from '../lib/host'

/** Chats this tab put in the Trash. Back onto one of their entries skips it (entries.skipGone); a link opened fresh still reads them. */
const deletedHere = new Set<string>()
export const wasDeletedHere = (id: string) => deletedHere.has(id)

const say = (failure: unknown) => (failure instanceof Error ? failure.message : 'The Hub did not take that.')

type Listener = (id: string, state: ChatMarks) => void
const listeners = new Set<Listener>()
/** The open thread hears every write to its own chat, so its header and banner follow a menu action at once. */
export const onChatMarks = (listener: Listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }

export async function setChatMarks(id: string, patch: ChatPatch) {
  const answer = await hubPost<{ id: string; state: ChatMarks }>(`/chat/${encodeURIComponent(id)}/state`, patch)
  listeners.forEach(listener => listener(id, answer.state))
  return answer
}

/** The part of a chat the actions read. */
export type ChatRef = Pick<ChatSummary, 'id' | 'title'> & Partial<Pick<ChatSummary, 'pinned' | 'archived' | 'trashed' | 'unread' | 'renamed'>>

/** A write the person asked for: a failure shows as a toast, never silently. */
async function write(id: string, patch: ChatPatch, done: string, undo?: () => Promise<unknown>) {
  try {
    await setChatMarks(id, patch)
    showUndo(done, undo)
    return true
  } catch (failure) {
    showUndo(say(failure))
    return false
  }
}

export async function pinChat(chat: ChatRef) {
  await write(chat.id, { pinned: !chat.pinned }, chat.pinned ? `Unpinned: ${chat.title}` : `Pinned: ${chat.title}`)
}

export async function markUnread(chat: ChatRef) {
  await write(chat.id, { unread: !chat.unread }, chat.unread ? `Marked as read: ${chat.title}` : `Marked as unread: ${chat.title}`)
}

export async function renameChat(chat: ChatRef, title: string) {
  return write(chat.id, { title: title.trim() || null }, title.trim() ? `Renamed: ${title.trim()}` : `Name cleared: ${chat.title}`)
}

/** Archive. Pinning and archiving clear each other, so Undo puts the pin back when the chat had one. */
export async function archiveChat(chat: ChatRef) {
  return write(chat.id, { archived: true }, `Archived: ${chat.title}`, async () => {
    await setChatMarks(chat.id, { archived: false })
    if (chat.pinned) await setChatMarks(chat.id, { pinned: true })
    showUndo(`Back in Chat: ${chat.title}`)
  })
}

/** Restore from Archived or from the Trash: it goes back where it was. */
export async function restoreChat(chat: ChatRef) {
  const ok = await write(chat.id, chat.trashed ? { trashed: false } : { archived: false }, `Restored: ${chat.title}`)
  if (ok) deletedHere.delete(chat.id)
  return ok
}

/** Delete: to the Trash, with Undo. The server stops this chat's running reply and holds its queue first. */
export async function trashChat(chat: ChatRef) {
  const ok = await write(chat.id, { trashed: true }, `Moved to Trash: ${chat.title}`, async () => {
    await setChatMarks(chat.id, { trashed: false })
    deletedHere.delete(chat.id)
    showUndo(`Back in Chat: ${chat.title}`)
  })
  if (ok) deletedHere.add(chat.id)
  return ok
}

/** The `...` menu of a chat. No items (so no button) for a visitor who cannot write. */
export function chatMenu(chat: ChatRef, onRename: () => void, around?: { leave?: () => void }): MenuItem[] | null {
  if (!host.write) return null
  const gone = !!chat.trashed || !!chat.archived
  const leave = (action: () => Promise<boolean | void>) => () => { void action().then(ok => { if (ok !== false) around?.leave?.() }) }
  return [
    { label: 'Rename', onSelect: onRename },
    ...(chat.trashed ? [] : [{ label: chat.pinned ? 'Unpin' : 'Pin', onSelect: () => void pinChat(chat) }]),
    { label: chat.unread ? 'Mark as read' : 'Mark as unread', onSelect: () => void markUnread(chat) },
    ...(gone ? [{ label: 'Restore', onSelect: () => void restoreChat(chat) }] : [{ label: 'Archive', onSelect: leave(() => archiveChat(chat)) }]),
    ...(chat.trashed ? [] : [{ label: 'Delete', danger: true, onSelect: leave(() => trashChat(chat)) }]),
  ]
}
