/** Saves what is at `url` to the downloads folder, under `name` or the last part of its path. */
export async function downloadFile(url: string, name?: string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Download failed (${response.status}).`)
  const blob = await response.blob(), objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a'); link.href = objectUrl
  link.download = name || decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || 'download')
  link.click(); setTimeout(() => URL.revokeObjectURL(objectUrl), 30000)
}

export const downloadImage = downloadFile
