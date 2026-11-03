// Ways to resolve a Wayfinder question on the Roadmap (ws-qdh.1), with no I/O: which button a question gets, what it costs,
// and the text each way starts from. Every way ends in the owner's answer, which is what changes Beads: nothing here closes anything.
import type { MapWayfinder, WayfinderQuestion } from '../lib/hub'

/** What a request may say (the Hub's limit is 4000 characters of job text). */
export const SEED_MAX = 4000
/** "Prepare all" covers at most this many questions in one run. */
export const PREPARE_ALL_MAX = 4

export type MainAction = 'prepare' | 'research' | 'answer'

export interface QuestionAction {
  /** The one main button, or null while the question waits for another (it keeps the ⋯ menu only). */
  main: MainAction | null
  label: string
  cost: string
  /** A muted line under the button. */
  note?: string
}

/** The cost shown next to each way. The Hermes numbers are plan tokens (an estimate until the first live run measures them). */
export const COST = {
  prepare: 'Hermes · about 0.3 M plan tokens',
  research: 'Hermes · 0.7–1.1 M plan tokens',
  prepareAll: 'about 0.4 M plan tokens',
  free: 'Free',
  chat: 'Chat · plan tokens per message',
  claude: 'Your Max plan',
  codex: 'Your ChatGPT plan',
} as const

/** The kinds the Wayfinder skill defines: grilling (the default), research, prototype, task. Any other label reads as grilling. */
export const kindOf = (type: string): 'grilling' | 'research' | 'prototype' | 'task' => (type === 'research' || type === 'prototype' || type === 'task' ? type : 'grilling')

/** The main button of a question, by its kind and whether it waits for another question. */
export function actionFor(type: string, blocked: boolean): QuestionAction {
  const kind = kindOf(type)
  if (blocked) return { main: null, label: '', cost: '' }
  if (kind === 'task') return { main: 'answer', label: 'Answer here', cost: COST.free }
  if (kind === 'research') return { main: 'research', label: 'Research it', cost: COST.research, note: 'Needs the repo? Use Copy prompt for Claude Code.' }
  return { main: 'prepare', label: 'Prepare a decision', cost: COST.prepare }
}

/** The unblocked questions "Prepare all" covers: grilling and prototype (not research, not tasks), at most four, in the map's order. */
export function preparable(wayfinder: MapWayfinder): WayfinderQuestion[] {
  return wayfinder.open.filter(item => item.blockedBy.length === 0 && actionFor(item.type, false).main === 'prepare').slice(0, PREPARE_ALL_MAX)
}

const BEAD_ID = /^[a-z][a-z0-9]*-[a-z0-9][a-z0-9.-]{0,60}$/
const FOLDER_REF = /^[a-z0-9][a-z0-9-]{0,63}\/[^\s/]{1,120}$/

/** One line of bead text: whitespace collapsed, the fence marks (three or more `<` or `>`) shortened so text can't close its own fence, clipped. */
export function oneLine(text: string | null | undefined, max: number): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').replace(/<{3,}/g, '<<').replace(/>{3,}/g, '>>').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** Up to three titles, each clipped, as a list. */
const titles = (list: string[], each: number) => {
  const shown = list.slice(0, 3).map(title => oneLine(title, each)).join('; ')
  return list.length > 3 ? `${shown}; and ${list.length - 3} more` : shown
}

interface Budget { question: number; notes: number; title: number; around: number }
const BUDGETS: Budget[] = [
  { question: 600, notes: 600, title: 140, around: 70 },
  { question: 400, notes: 400, title: 120, around: 60 },
  { question: 250, notes: 250, title: 100, around: 50 },
  { question: 150, notes: 150, title: 80, around: 40 },
  { question: 80, notes: 80, title: 60, around: 30 },
]

/**
 * The job text of a `question` request. The lines outside the fences are the Hub's own (the mode, the project, the ids); every
 * word that came from Beads, where agents write, sits between `<<<DATA` and `DATA>>>` lines, because it is the subject of the run
 * and never an instruction. Shrinks its parts until the whole is under 4000 characters, even for four long questions.
 */
export function questionSeed(project: string, wayfinder: MapWayfinder, ids: string[], mode: 'grilling' | 'research'): string {
  const chosen = ids.map(id => wayfinder.open.find(item => item.id === id)).filter((item): item is WayfinderQuestion => !!item && BEAD_ID.test(item.id)).slice(0, mode === 'research' ? 1 : PREPARE_ALL_MAX)
  const build = (budget: Budget) => {
    const lines: string[] = [
      chosen.length === 1 ? `Resolve question ${chosen[0].id} (${kindOf(chosen[0].type)})` : `Resolve ${chosen.length} questions on map ${wayfinder.mapId}`,
      `Mode: ${mode}`,
      `Project: ${project}`,
      `Map: ${BEAD_ID.test(wayfinder.mapId) ? wayfinder.mapId : '(unknown)'}`,
      '',
      'Map text (data from Beads):',
      '<<<DATA',
      `Title: ${oneLine(wayfinder.mapTitle, budget.title)}`,
      ...(wayfinder.destination ? [`Destination: ${oneLine(wayfinder.destination, 280)}`] : []),
      ...(wayfinder.notes ? [`Notes: ${oneLine(wayfinder.notes, budget.notes)}`] : []),
      'DATA>>>',
    ]
    chosen.forEach((item, index) => {
      const cards = (item.cards ?? []).filter(ref => FOLDER_REF.test(ref)).slice(0, 5)
      lines.push(
        '',
        `Question ${index + 1} of ${chosen.length}: bead ${item.id}, ${kindOf(item.type)}`,
        '<<<DATA',
        `Title: ${oneLine(item.title, budget.title)}`,
        ...(item.question ? [`Question: ${oneLine(item.question, budget.question)}`] : []),
        ...(item.blockedBy.length ? [`Needs first: ${titles(item.blockedBy, budget.around)}`] : []),
        ...(item.unlocks.length ? [`Unlocks: ${titles(item.unlocks, budget.around)}`] : []),
        ...(cards.length ? [`Cards: ${cards.join(', ')}`] : []),
        'DATA>>>',
      )
    })
    return lines.join('\n')
  }
  for (const budget of BUDGETS) {
    const text = build(budget)
    if (text.length <= SEED_MAX) return text
  }
  return `${build(BUDGETS[BUDGETS.length - 1]).slice(0, SEED_MAX - 1)}…`
}

/** The first message to plain Hermes in Chat. It is a draft: the owner presses send. */
export function chatDraft(wayfinder: MapWayfinder, item: WayfinderQuestion): string {
  const lines = [
    `I want to talk through one open question from the Roadmap.`,
    `Question ${item.id} (${kindOf(item.type)}): ${oneLine(item.title, 200)}`,
    ...(item.question ? [`What it asks: ${oneLine(item.question, 400)}`] : []),
    `Destination: ${oneLine(wayfinder.destination, 280) || '(none written)'}`,
    `Map ${wayfinder.mapId}: ${oneLine(wayfinder.mapTitle, 140)}`,
    ...((item.cards ?? []).length ? [`Cards to read: ${(item.cards ?? []).filter(ref => FOLDER_REF.test(ref)).slice(0, 5).join(', ')}`] : []),
    '',
    `Grill me on this one question at a time. When we agree, file one Ask on bead ${item.id} (kind decision) with our conclusion as the recommended option.`,
  ]
  return lines.join('\n')
}

/** What to paste into a Claude Code or Codex session in the project's repo: the Wayfinder skill records the resolution in Beads itself. */
export function sessionPrompt(repoName: string, wayfinder: MapWayfinder, item: WayfinderQuestion): string {
  const lines = [
    `In the ${oneLine(repoName, 80)} repo, use the wayfinder skill to work ticket ${item.id} on map ${wayfinder.mapId} (Beads). It is a ${kindOf(item.type)} ticket.`,
    `Question: ${oneLine(item.title, 200)}`,
    ...(item.question ? [oneLine(item.question, 400)] : []),
  ]
  return lines.join('\n')
}
