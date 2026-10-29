/**
 * Built-in 16 x 16 pixel sprites for the agents, and the name-seeded Randomize.
 * PLACEHOLDER ART: drawn for the Mission Control mockup so every agent has a face before any
 * real avatar exists. Replace a sprite by editing its rows; keep 16 rows of 16 characters, and
 * every letter must be a key of that sprite's palette ('.' is empty).
 */
export type SpriteData = { palette: Record<string, string>; rows: string[] }
export type GeneratedSprite = SpriteData & { label: string }

/** What an agent's avatar choice resolves to. */
export type SpriteChoice =
  | { kind: 'builtin'; key: string; name?: string }
  | { kind: 'random'; salt: number; name: string }

export const BUILTIN: Record<string, SpriteData> = {
  hermes: {
    palette: { w: '#f5f7fa', W: '#aab4c3', g: '#f2c14e', G: '#b8862b', s: '#f1c6a0', e: '#1b1d22', m: '#8a3b2e', t: '#2fb5a8', T: '#1d7a72' },
    rows: [
      '................',
      '.ww....gg....ww.',
      'wWww..gggg..wwWw',
      '.wWwwgGGGGgwwWw.',
      '..wWwggggggwWw..',
      '....gGGGGGGg....',
      '....ssssssss....',
      '....sesssses....',
      '....ssssssss....',
      '....sssmmsss....',
      '.....tttttt.....',
      '...stTttttTts...',
      '...s.tttttt.s...',
      '.....tTttTt.....',
      '.....ss..ss.....',
      '.....gg..gg.....',
    ],
  },
  briefs: {
    palette: { r: '#e2554f', p: '#f3ead7', P: '#cbbd9d', l: '#7d828c', k: '#1b1d22' },
    rows: [
      '................',
      '...rrrrrrrrrr...',
      '...rrrrrrrrrr...',
      '...ppppppppPP...',
      '...pllllpllPP...',
      '...ppppppppPP...',
      '...ppkpppkppP...',
      '...ppkpppkppP...',
      '...ppppppppPP...',
      '...pppkkkpppP...',
      '...ppppppppPP...',
      '...pllllllpPP...',
      '...ppppppppPP...',
      '....PPPPPPPP....',
      '.....k....k.....',
      '....kk....kk....',
    ],
  },
  researcher: {
    palette: { b: '#8a5a3b', B: '#5e3b24', c: '#f3dfbd', y: '#f7d34a', k: '#1b1d22', a: '#e98a3c', o: '#e98a3c' },
    rows: [
      '................',
      '...B........B...',
      '...bB......Bb...',
      '...bbbbbbbbbb...',
      '..bbyyybbyyybb..',
      '..bbykybbykybb..',
      '..bbyyybbyyybb..',
      '..bbbbbaabbbbb..',
      '..bbbcccacccbb..',
      '..bBccccccccBb..',
      '..bBccccccccBb..',
      '..bBcccccccBBb..',
      '...bBccccccBb...',
      '....bbbbbbbb....',
      '.....oo..oo.....',
      '................',
    ],
  },
  librarian: {
    palette: { u: '#4f7bc0', r: '#c0504d', g: '#4f9a6b', y: '#e3b448', p: '#efe6d2', k: '#1b1d22' },
    rows: [
      '................',
      '....uuuuuuuu....',
      '....uppppppu....',
      '....ukppppku....',
      '....uppppppu....',
      '....uuuuuuuu....',
      '...rrrrrrrrrr...',
      '...rppppppppr...',
      '...rrrrrrrrrr...',
      '....gggggggg....',
      '...kgppppppgk...',
      '....gggggggg....',
      '..yyyyyyyyyyyy..',
      '..yppppppppppy..',
      '..yyyyyyyyyyyy..',
      '...kk......kk...',
    ],
  },
  architect: {
    palette: { h: '#f2c14e', H: '#c08f22', m: '#9aa5b4', M: '#5f6a7a', v: '#6ec3ff', k: '#1b1d22', u: '#2c5d9e', w: '#e8eef7' },
    rows: [
      '................',
      '......hhhh......',
      '....hhhhhhhh....',
      '...HhhhhhhhhH...',
      '..HHHHHHHHHHHH..',
      '....mmmmmmmm....',
      '....mvvvvvvm....',
      '....mvkvvkvm....',
      '....mmmmmmmm....',
      '.....MmmmmM.....',
      '...uuuuuuuuuu...',
      '..muuuuuuuuuum..',
      '..muwwwwwwwwum..',
      '...uuuuuuuuuu...',
      '....MM....MM....',
      '...MMM....MMM...',
    ],
  },
  developer: {
    palette: { h: '#7c5cd6', H: '#523a9e', f: '#17141f', e: '#7ef0ff', k: '#2a2d33', l: '#9aa5b4', s: '#c9b8ff' },
    rows: [
      '................',
      '......HHHH......',
      '.....HhhhhH.....',
      '....HhhhhhhH....',
      '...HhhffffhhH...',
      '...HhffffffhH...',
      '...HhfeffefhH...',
      '...HhffffffhH...',
      '...HhhffffhhH...',
      '...HhhhhhhhhH...',
      '..HhhhhhhhhhhH..',
      '..HhhhHhhHhhhH..',
      '..hhllllllllhh..',
      '..hhkkkkkkkkhh..',
      '....HHH..HHH....',
      '....kkk..kkk....',
    ],
  },
  reviewer: {
    palette: { b: '#2e3442', B: '#1b1f29', g: '#8792a4', y: '#f2c14e', w: '#f5f7fa', k: '#0a0b0d', o: '#e98a3c' },
    rows: [
      '................',
      '......bbbb......',
      '.....bbbbbb.....',
      '....bbbbbbyyy...',
      '....bwkbbbykyb..',
      '....bbbbbbyyyb..',
      '..ooobbbbbbbbb..',
      '...oobbbbbbbbb..',
      '.....bbbbbbbbb..',
      '....bbgbbbbbbbb.',
      '....bggbbbbbbbb.',
      '....bggbbbbbbBB.',
      '.....bbbbbbbBBBB',
      '......bbbbbb....',
      '.......o..o.....',
      '......oo.oo.....',
    ],
  },
  qa: {
    palette: { g: '#7cc46a', G: '#4a8a42', w: '#f5f7fa', k: '#1b1d22', p: '#f39ab0', y: '#e6e0a4' },
    rows: [
      '................',
      '................',
      '...ww......ww...',
      '..wkwG....Gwkw..',
      '..wwwggggggwww..',
      '.gggggggggggggg.',
      'gggggggggggggggg',
      'gpggggggggggggpg',
      'ggkkkkkkkkkkkkgg',
      '.gggggggggggggg.',
      '..gyyyyyyyyyyg..',
      '.GgyyyyyyyyyygG.',
      'GGggyyyyyyyyggGG',
      'GG.gggggggggg.GG',
      '...GGG....GGG...',
      '................',
    ],
  },
  artist: {
    palette: { r: '#d9534f', R: '#9c3633', s: '#f6c9b6', S: '#dc9f88', k: '#1b1d22', b: '#8a5a3b', c: '#57c2e6', y: '#f2c14e' },
    rows: [
      '................',
      '......rr........',
      '....rrrrrrr.....',
      '...rrrrrrrrrR...',
      '....RRRRRRRR..y.',
      '...ssssssssss.c.',
      '..ssssssssssss..',
      '..ssskssssksss.c',
      '..ssssssssssssb.',
      '..ssssskksssssb.',
      '..SssssssssssSb.',
      '...SssssssssS.b.',
      '....SSSSSSSS..b.',
      '.....SS..SS.....',
      '................',
      '................',
    ],
  },
  lib_b: {
    palette: { g: '#8bcf6a', G: '#5a9a45', k: '#1b1d22', w: '#f5f7fa', B: '#a8433f', p: '#efe6d2', P: '#b9a988' },
    rows: [
      '................',
      '......gggg......',
      '.....gggggg.....',
      '....kkkggkkk....',
      '....kwkggkwk....',
      '....kkkggkkk....',
      '.....gggggg.....',
      '.....gGggGg.....',
      '......gggg......',
      '......gGGg......',
      '..BBBBBggBBBBB..',
      '..BppppggppppB..',
      '..BpPPpppPPppB..',
      '..BppppppppppB..',
      '..BBBBBBBBBBBB..',
      '...BBBBBBBBBB...',
    ],
  },
  lib_c: {
    palette: { y: '#f2c14e', M: '#5f6a7a', m: '#a7b1bf', c: '#7ef0ff', k: '#1b1d22' },
    rows: [
      '.......y........',
      '.......M........',
      '...MMMMMMMMMM...',
      '...MmmmmmmmmM...',
      '...MmcmmmmcmM...',
      '...MmmmkkmmmM...',
      '...MMMMMMMMMM...',
      '...MmmmmmmmmM...',
      '...MmmyyyymmM...',
      '...MmmmkkmmmM...',
      '...MMMMMMMMMM...',
      '...MmmyyyymmM...',
      '...MmmmkkmmmM...',
      '...MMMMMMMMMM...',
      '....MM....MM....',
      '....kk....kk....',
    ],
  },
  lib_d: {
    palette: { o: '#e98a3c', O: '#a85d22', k: '#1b1d22', w: '#f5f7fa', p: '#f39ab0', c: '#f6e3c3', n: '#4f7bc0' },
    rows: [
      '................',
      '..o..........o..',
      '..oo........oo..',
      '..oOo......oOo..',
      '..oooooooooooo..',
      '..okkkooookkko..',
      '..okwkooookwko..',
      '..okkkooookkko..',
      '..oooooppooooo..',
      '..ooccccccccoo..',
      '...occckkccco...',
      '...oooooooooo...',
      '..oonnnnnnnoo...',
      '..oonwwwwwnoo...',
      '...ooonnnooo....',
      '...OO.....OO....',
    ],
  },
  dev_teal: {
    palette: { h: '#2fb5a8', H: '#1d7a72', f: '#17141f', e: '#7ef0ff', k: '#2a2d33', l: '#9aa5b4', s: '#a8f0e6' },
    rows: [
      '................',
      '......HHHH......',
      '.....HhhhhH.....',
      '....HhhhhhhH....',
      '...HhhffffhhH...',
      '...HhffffffhH...',
      '...HhfeffefhH...',
      '...HhffffffhH...',
      '...HhhffffhhH...',
      '...HhhhhhhhhH...',
      '..HhhhhhhhhhhH..',
      '..HhhhHhhHhhhH..',
      '..hhllllllllhh..',
      '..hhkkkkkkkkhh..',
      '....HHH..HHH....',
      '....kkk..kkk....',
    ],
  },
  qa_violet: {
    palette: { g: '#b48ef0', G: '#7a5cc4', w: '#f5f7fa', k: '#1b1d22', p: '#f39ab0', y: '#e9defc' },
    rows: [
      '................',
      '................',
      '...ww......ww...',
      '..wkwG....Gwkw..',
      '..wwwggggggwww..',
      '.gggggggggggggg.',
      'gggggggggggggggg',
      'gpggggggggggggpg',
      'ggkkkkkkkkkkkkgg',
      '.gggggggggggggg.',
      '..gyyyyyyyyyyg..',
      '.GgyyyyyyyyyygG.',
      'GGggyyyyyyyyggGG',
      'GG.gggggggggg.GG',
      '...GGG....GGG...',
      '................',
    ],
  },
  owl_snow: {
    palette: { b: '#d9dde3', B: '#8e98a8', c: '#ffffff', y: '#f7d34a', k: '#1b1d22', a: '#e98a3c', o: '#e98a3c' },
    rows: [
      '................',
      '...B........B...',
      '...bB......Bb...',
      '...bbbbbbbbbb...',
      '..bbyyybbyyybb..',
      '..bbykybbykybb..',
      '..bbyyybbyyybb..',
      '..bbbbbaabbbbb..',
      '..bbbcccacccbb..',
      '..bBccccccccBb..',
      '..bBccccccccBb..',
      '..bBcccccccBBb..',
      '...bBccccccBb...',
      '....bbbbbbbb....',
      '.....oo..oo.....',
      '................',
    ],
  },
  artist_blue: {
    palette: { r: '#4f7bc0', R: '#2f5590', s: '#f6c9b6', S: '#dc9f88', k: '#1b1d22', b: '#8a5a3b', c: '#57c2e6', y: '#f2c14e' },
    rows: [
      '................',
      '......rr........',
      '....rrrrrrr.....',
      '...rrrrrrrrrR...',
      '....RRRRRRRR..y.',
      '...ssssssssss.c.',
      '..ssssssssssss..',
      '..ssskssssksss.c',
      '..ssssssssssssb.',
      '..ssssskksssssb.',
      '..SssssssssssSb.',
      '...SssssssssS.b.',
      '....SSSSSSSS..b.',
      '.....SS..SS.....',
      '................',
      '................',
    ],
  },
  arch_red: {
    palette: { h: '#e2554f', H: '#a83b38', m: '#9aa5b4', M: '#5f6a7a', v: '#6ec3ff', k: '#1b1d22', u: '#2c5d9e', w: '#e8eef7' },
    rows: [
      '................',
      '......hhhh......',
      '....hhhhhhhh....',
      '...HhhhhhhhhH...',
      '..HHHHHHHHHHHH..',
      '....mmmmmmmm....',
      '....mvvvvvvm....',
      '....mvkvvkvm....',
      '....mmmmmmmm....',
      '.....MmmmmM.....',
      '...uuuuuuuuuu...',
      '..muuuuuuuuuum..',
      '..muwwwwwwwwum..',
      '...uuuuuuuuuu...',
      '....MM....MM....',
      '...MMM....MMM...',
    ],
  },
}

/** The built-in keys, in picker order. The server list in site/api/hub-team.mjs must equal this. */
export const BUILTIN_KEYS: string[] = Object.keys(BUILTIN)

const SIZE = 16

/** A small deterministic sprite from a name and a salt (FNV-1a seed, LCG stream). */
export function genSprite(name: string, salt: number): GeneratedSprite {
  let s = 2166136261
  for (const c of name + '#' + salt) { s ^= c.charCodeAt(0); s = Math.imul(s, 16777619) >>> 0 }
  const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
  const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)]
  const h = Math.floor(r() * 360)
  const h2 = (h + 100 + Math.floor(r() * 160)) % 360
  const L = (hh: number, sa: number, li: number) => `hsl(${hh} ${sa}% ${li}%)`
  const palette: Record<string, string> = {
    b: L(h, 55, 60), d: L(h, 45, 40), l: L(h, 70, 80), k: '#1b1d22', w: '#f5f7fa',
    a: L(h2, 65, 60), A: L(h2, 55, 40), G: '#4e8f45', F: '#7cc46a', p: '#f39ab0',
  }
  const shape = pick(['blob', 'bot', 'ghost', 'critter'])
  let acc = pick(['hat', 'glasses', 'scarf', 'sprout', 'antenna', 'none'])
  if (shape === 'critter' && acc === 'hat') acc = 'glasses'
  const HW: Record<string, [number, number[]]> = {
    blob: [3, [3, 5, 6, 6, 7, 7, 7, 7, 6, 6, 4]],
    bot: [3, [6, 6, 6, 6, 6, 6, 6, 6, 6, 6]],
    ghost: [3, [4, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6]],
    critter: [4, [5, 6, 6, 7, 7, 7, 7, 6, 6, 5]],
  }
  const [top, ws] = HW[shape]
  const bot = top + ws.length - 1
  const G: string[][] = Array.from({ length: SIZE }, () => Array<string>(SIZE).fill('.'))
  const put = (x: number, y: number, c: string) => { if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) G[y][x] = c }
  const mir = (x: number, y: number, c: string) => { put(x, y, c); put(15 - x, y, c) }
  ws.forEach((w, i) => { for (let j = 0; j < w; j++) mir(7 - j, top + i, i >= ws.length - 2 ? 'd' : 'b') })
  put(8 - ws[1] + 1, top + 1, 'l'); put(8 - ws[1] + 2, top + 1, 'l'); put(8 - ws[2] + 1, top + 2, 'l')
  if (shape === 'ghost') { mir(2, bot, '.'); mir(5, bot, '.') }
  if (shape === 'critter') { mir(3, top - 1, 'b'); mir(4, top - 1, 'l'); mir(3, top - 2, 'b') }
  const ey = top + 3
  if (shape === 'bot') {
    for (let x = 3; x < 13; x++) put(x, ey, 'k')
    mir(4, ey, 'a'); mir(5, ey, 'a')
  } else {
    const st = pick(['dot', 'tall', 'glint'])
    if (st === 'dot') mir(5, ey + 1, 'k')
    else { mir(5, ey, st === 'glint' ? 'w' : 'k'); mir(5, ey + 1, 'k') }
  }
  const my = top + (shape === 'bot' ? 6 : 5)
  const mo = pick(['smile', 'o', 'flat'])
  if (mo === 'smile') { mir(6, my, 'k'); put(7, my + 1, 'k'); put(8, my + 1, 'k') }
  else if (mo === 'o') { put(7, my, 'k'); put(8, my, 'k'); put(7, my + 1, 'k'); put(8, my + 1, 'k') }
  else { put(7, my, 'k'); put(8, my, 'k') }
  if (shape !== 'bot' && r() < 0.5) mir(4, top + 5, 'p')
  if (acc === 'hat') {
    for (let j = 0; j < 5; j++) mir(7 - j, top - 1, 'A')
    for (let j = 0; j < 3; j++) { mir(7 - j, top - 2, 'a'); mir(7 - j, top - 3, 'a') }
  } else if (acc === 'glasses' && shape !== 'bot') {
    for (const x of [4, 6]) { mir(x, ey, 'a'); mir(x, ey + 1, 'a') }
    mir(5, ey - 1, 'a'); mir(5, ey + 2, 'a'); put(7, ey, 'a'); put(8, ey, 'a')
  } else if (acc === 'scarf') {
    const sy = bot - 3
    for (let j = 0; j < ws[sy - top]; j++) mir(7 - j, sy, 'a')
    put(5, sy + 1, 'a'); put(5, sy + 2, 'A')
  } else if (acc === 'sprout') {
    put(7, top - 1, 'G'); put(8, top - 1, 'G'); put(5, top - 2, 'F'); put(6, top - 2, 'F'); put(6, top - 1, 'F')
    put(9, top - 3, 'F'); put(10, top - 3, 'F'); put(9, top - 2, 'F')
  } else if (acc === 'antenna' || shape === 'bot') {
    put(7, top - 1, 'd'); put(8, top - 1, 'd'); put(7, top - 2, 'a'); put(8, top - 2, 'a')
  }
  if (shape === 'blob' || shape === 'critter') { mir(5, bot + 1, 'd'); mir(6, bot + 1, 'd') }
  const what = acc === 'none' || (acc === 'glasses' && shape === 'bot') ? ''
    : acc === 'glasses' ? ' with glasses' : acc === 'antenna' ? ' with an antenna' : ` with a ${acc}`
  return { palette, rows: G.map(row => row.join('')), label: shape + what }
}

/** The sprite an agent has before anyone picks one: its own built-in, else a name-seeded one. */
export function defaultSprite(agentId: string, name: string): SpriteChoice {
  return Object.prototype.hasOwnProperty.call(BUILTIN, agentId) ? { kind: 'builtin', key: agentId } : { kind: 'random', salt: 0, name }
}

/** Turn a choice into drawable data. An unknown built-in key falls back to the name-seeded sprite. */
export function resolveSprite(choice: SpriteChoice): SpriteData {
  if (choice.kind === 'builtin') {
    if (Object.prototype.hasOwnProperty.call(BUILTIN, choice.key)) return BUILTIN[choice.key]
    return genSprite(choice.name || choice.key, 0)
  }
  return genSprite(choice.name, choice.salt)
}
