// The archive date rule, with nothing to import: the Library's model and its tests read it without a browser.
export const ARCHIVE_DAYS = 7

export function archiveCutoff(): string {
  const d = new Date()
  d.setDate(d.getDate() - ARCHIVE_DAYS)
  return d.toISOString().slice(0, 10)
}
