// Scenes the Hub starts drawings from, and the hand-off from Sketch to an Ask's answer.

export interface Drawn { scene: string; png: string }

const SOURCE = 'bunnyufo-workspace'

/**
 * A one-element scene: the picture `fileName`, locked, at `w` x `h`, referenced by name and not
 * held in the scene. The same scene the card routes write for ✎ Annotate (`annotate` in
 * site/api/card-writes.mjs); keep the two in step.
 */
export function annotationScene(fileName: string, w: number, h: number): string {
  const name = fileName.split('/').pop() ?? fileName
  return `${JSON.stringify({
    type: 'excalidraw', version: 2, source: SOURCE,
    elements: [{
      type: 'image', id: 'buw-bg', x: 0, y: 0, width: w, height: h, locked: true,
      status: 'saved', fileId: `buw:${name}`, scale: [1, 1], customData: { buwSrc: name },
    }],
    appState: { viewBackgroundColor: '#ffffff' }, files: {},
  })}\n`
}

export const blankScene = (): string => `${JSON.stringify({ type: 'excalidraw', version: 2, source: SOURCE, elements: [], appState: { viewBackgroundColor: '#ffffff' }, files: {} })}\n`

// Sketch → Ask: the drawing travels in memory, and the owner still taps Send answer on the Ask.
let handoff: Drawn | null = null
export const setHandoff = (drawn: Drawn) => { handoff = drawn }
export const takeHandoff = (): Drawn | null => { const value = handoff; handoff = null; return value }
