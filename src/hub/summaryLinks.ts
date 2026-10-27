import { reviewHash } from '../lib/route'

const REPO = /^[\w.-]+\/[\w.-]+$/

export interface LinkContext {
  /** `owner/repo` of the sprint card's section, when known. */
  repo?: string
  /** The pull requests the event carries, for the owner of a bare `repo#N`. */
  prs: string[]
  /** The review's event file and the card files that open in place. */
  id: string
  files: string[]
}

const ownerOf = (context: LinkContext) => {
  if (context.repo && REPO.test(context.repo)) return context.repo.split('/')[0]
  const fromPr = context.prs.map(url => /^https:\/\/github\.com\/([\w.-]+)\//.exec(url)?.[1]).find(Boolean)
  return fromPr
}

/** One reference found in the text: where it is, what it says, and where it goes. */
interface Hit { start: number; end: number; text: string; href: string; pr?: string }

const PR_URL = (repo: string, number: string) => `https://github.com/${repo}/pull/${number}`

/**
 * References in a summary as plain text turned into links. Nothing is HTML: the result is
 * Markdown the caller renders without raw HTML. `owner/repo#N` and, with a known owner, `repo#N`
 * and (with a known repo) `PR #N` or `#N` become pull request links; a cited card file that is
 * in `files` opens in place. Anything else stays as it was.
 * → { text, prs } where prs are the pull request urls in the order they were found.
 */
export function linkSummary(summary: string, context: LinkContext): { text: string; prs: string[] } {
  const hits: Hit[] = []
  const taken = (start: number, end: number) => hits.some(hit => start < hit.end && end > hit.start)
  const add = (hit: Hit) => { if (!taken(hit.start, hit.end)) hits.push(hit) }
  const owner = ownerOf(context)
  // Not inside a word, a path or an existing Markdown link.
  const free = (index: number) => !/[\w./[(-]/.test(summary[index - 1] ?? '') || (summary[index - 1] === '(' && summary[index - 2] !== ']')

  for (const match of summary.matchAll(/[\w.-]+(?:\/[\w.-]+)*\.md(?![\w-])/g)) {
    const path = match[0]
    const start = match.index ?? 0
    if (!free(start) && summary[start - 1] !== '`') continue
    if (context.files.includes(path)) add({ start, end: start + path.length, text: path, href: reviewHash(context.id, path) })
  }
  for (const match of summary.matchAll(/([\w.-]+)\/([A-Za-z][\w.-]*)#(\d+)(?![\w-])/g)) {
    const start = match.index ?? 0
    if (!free(start)) continue
    add({ start, end: start + match[0].length, text: match[0], href: PR_URL(`${match[1]}/${match[2]}`, match[3]), pr: PR_URL(`${match[1]}/${match[2]}`, match[3]) })
  }
  for (const match of summary.matchAll(/(?<![\w./-])([A-Za-z][\w.-]*)#(\d+)(?![\w-])/g)) {
    const start = match.index ?? 0
    if (!owner || !free(start)) continue
    const url = PR_URL(`${owner}/${match[1]}`, match[2])
    add({ start, end: start + match[0].length, text: match[0], href: url, pr: url })
  }
  for (const match of summary.matchAll(/(?<![\w&#/])(?:PR\s+)?#(\d+)(?![\w-])/gi)) {
    const start = match.index ?? 0
    if (!context.repo || !REPO.test(context.repo) || !free(start)) continue
    const url = PR_URL(context.repo, match[1])
    add({ start, end: start + match[0].length, text: match[0], href: url, pr: url })
  }
  hits.sort((a, b) => a.start - b.start)
  let text = ''
  let at = 0
  const prs: string[] = []
  for (const hit of hits) {
    text += summary.slice(at, hit.start) + `[${hit.text.replace(/[[\]\\]/g, match => `\\${match}`)}](${hit.href})`
    at = hit.end
    if (hit.pr && !prs.includes(hit.pr)) prs.push(hit.pr)
  }
  return { text: text + summary.slice(at), prs: prs.slice(0, 10) }
}
