// What a code block's Copy button puts on the clipboard. Pasting several lines into PowerShell runs each one as it
// arrives, so a command that reads the console (claude, ssh, a prompt) swallows the lines after it, and Windows Terminal
// stops to warn first. A plain multi-line PowerShell block is copied as one line joined with "; " instead: nothing runs
// until Enter, and the commands run in order. Anything that is not plain is copied as shown.

const POWERSHELL = new Set(['powershell', 'pwsh', 'ps1', 'ps'])

/** A line that only makes sense next to its neighbours: a comment after code or a "#" in a string, a continuation, a here-string, a block. */
const TIED = /#|[`|{([,=+&]$|^[})\]|]|@["']|["']@/
/** A line that opens a session, so the lines after it were meant for that session, not for this shell. */
const SESSION = /^(ssh|Enter-PSSession)\b|^pct\s+enter\b|\s-(it|ti)\b|^(powershell|pwsh|cmd|bash|sh|python3?|node|wsl)(\.exe)?$/i

export function copyText(code: string, lang = ''): { text: string; oneLine: boolean } {
  const shown = { text: code, oneLine: false }
  if (!POWERSHELL.has(lang.toLowerCase())) return shown
  const lines = code.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  if (lines.length < 2 || lines.some(line => TIED.test(line))) return shown
  if (lines.slice(0, -1).some(line => SESSION.test(line))) return shown
  return { text: lines.map(line => line.replace(/;+$/, '')).join('; '), oneLine: true }
}
