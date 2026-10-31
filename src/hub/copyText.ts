// What a code block's Copy button puts on the clipboard. Pasting several lines into PowerShell runs each one as it
// arrives, so a command that reads the console (claude, ssh, a prompt) swallows the lines after it, and Windows Terminal
// stops to warn first. A plain multi-line PowerShell block is copied as one line joined with "; " instead: nothing runs
// until Enter, and the commands run in order. Anything that is not plain is copied as shown: a wrong join would change
// what runs, while a block copied as shown only behaves as it always did.

const POWERSHELL = new Set(['powershell', 'pwsh', 'ps1', 'ps'])

/** A line that only makes sense next to its neighbours. */
const TIED = [
  /#/,                                  // a comment after code, or a "#" in a string
  /[`|{([,=+&]$/,                       // a continuation or an open block at its end
  /^[})\]|]/,                           // the end of the line before
  /@["']|["']@/,                        // a here-string
  /\s-(and|or|xor|not|band|bor|bxor|shl|shr|eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin|replace|split|join|f|is|isnot|as)$/i,   // an operator waiting for its right side
  /^(else|elseif|catch|finally|until)\b/i,   // the rest of a statement
]
/** A line that opens a session, so the lines after it were meant for that session, not for this shell. */
const SESSION = [
  /^(ssh|Enter-PSSession|wsl|mysql|psql|sqlite3|redis-cli|sftp|ftp|telnet|nslookup)(\.exe)?\b/i,
  /^claude(\.exe)?(?=\s|$)(?!\s+(plugin|auth|mcp|update|doctor|config|install|setup-token|-p|--print|-v|--version|-h|--help)\b)/i,
  /^(python3?|py|node)(\.exe)?(\s*$|\s+-i\b)/i,
  /^(powershell|pwsh)(\.exe)?(\s*$|\s.*-NoExit\b)/i,
  /^cmd(\.exe)?(\s*$|\s+\/k\b)/i,
  /^(bash|sh|zsh)(\.exe)?(\s*$|\s+-[il]\b)/i,
  /\s-(it|ti)\b/,                       // docker exec -it, kubectl exec -it
  /-NoExit\b/i,
]

const odd = (line: string, mark: string) => line.split(mark).length % 2 === 0
const unbalanced = (line: string) => [['(', ')'], ['{', '}'], ['[', ']']].some(([open, close]) => line.split(open).length !== line.split(close).length)

export function copyText(code: string, lang = ''): { text: string; oneLine: boolean } {
  const shown = { text: code, oneLine: false }
  if (!POWERSHELL.has(lang.toLowerCase())) return shown
  const raw = code.split(/\r?\n/)
  // A string that spans lines: joining would put "; " inside it, and the comment filter would drop lines from it.
  if (raw.some(line => odd(line, '"') || odd(line, "'"))) return shown
  const lines = raw.map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  if (lines.length < 2 || lines.some(line => unbalanced(line) || TIED.some(re => re.test(line)))) return shown
  if (lines.slice(0, -1).some(line => SESSION.some(re => re.test(line)))) return shown
  return { text: lines.map(line => line.replace(/;+$/, '')).join('; '), oneLine: true }
}
