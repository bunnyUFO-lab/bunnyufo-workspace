// The change list of a plan Ask (ws-qdh.3), with no I/O: one validator for the card API (a limited token may not put an ask.json with a bad
// list), the site (a bad list is dropped when an Ask is read, and a good one becomes the Design review rows) and the cards client
// (`cards ask create --changes`, `cards plan apply`). The cards client is one file with no imports, so it carries a copy of the first
// block below and of the prose-command block; scripts/cards.test.mjs keeps both copies equal to these.

// --- ask-changes:start (the same block is in site/api/ask-changes.mjs and site/card-api/cards.mjs; scripts/cards.test.mjs keeps them equal) ---
/**
 * The change list of a plan Ask (ws-qdh.3): what the owner approves, row by row, before a session applies it to Beads.
 * `validateChanges` returns the problems with a list (an empty array when it is good); it never throws. Every op, field and label is
 * allow-listed, ids are Beads ids (or `#n`, the n-th change of the list, for something an earlier `create` makes), and free text
 * may not hold a command. `describeChange` is the one line the Hub shows for a change: built from the op, with the agent's text
 * quoted inside it, never alone.
 */
const CHANGES_MAX = 20;
const CHANGE_OPS = ['create', 'update', 'dep', 'close', 'label', 'card'];
const CHANGE_KEYS = {
  create: ['op', 'title', 'type', 'parent', 'description', 'labels'],
  update: ['op', 'bead', 'title', 'description'],
  dep: ['op', 'bead', 'blocks'],
  close: ['op', 'bead', 'reason'],
  label: ['op', 'bead', 'add', 'remove'],
  card: ['op', 'card'],
};
const CHANGE_TYPES = ['task', 'feature', 'epic'];
const CHANGE_LIMITS = { title: 120, description: 2000, reason: 200, labels: 5 };
const CHANGE_BEAD = /^[a-z][a-z0-9]*-[a-z0-9][a-z0-9.-]{0,60}$/;
const CHANGE_CARD = /^assistant\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const CHANGE_LABEL = /^(?:wayfinder:[a-z]{2,20}|milestone|needs-owner|later)$/;

export function validateChanges(changes) {
  const problems = [];
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > CHANGES_MAX) return [`changes is a list of 1 to ${CHANGES_MAX}`];
  const made = new Set();
  const textOk = (at, name, value, max, { required = false } = {}) => {
    if (value === undefined && !required) return;
    if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) { problems.push(`${at}: ${name} is ${required ? `1 to ${max}` : `at most ${max}`} characters of text`); return; }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/.test(value)) { problems.push(`${at}: ${name} has a control character`); return; }
    const found = proseCommand(value);
    if (found) problems.push(`${at}: ${name} has a command in its text (${found.slice(0, 40)}); describe it in words`);
  };
  const beadOk = (at, name, value, index) => {
    if (typeof value === 'string' && CHANGE_BEAD.test(value)) return;
    const ref = typeof value === 'string' ? /^#([1-9][0-9]?)$/.exec(value) : null;
    if (ref && made.has(Number(ref[1])) && Number(ref[1]) < index + 1) return;
    problems.push(`${at}: ${name} is a Beads id, or #n for a create earlier in the list`);
  };
  const labelsOk = (at, name, value) => {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.length < 1 || value.length > CHANGE_LIMITS.labels || new Set(value).size !== value.length || !value.every(label => typeof label === 'string' && CHANGE_LABEL.test(label))) {
      problems.push(`${at}: ${name} is 1 to ${CHANGE_LIMITS.labels} different labels from: wayfinder:<type>, milestone, needs-owner, later`);
    }
  };
  changes.forEach((change, index) => {
    const at = `change ${index + 1}`;
    if (!change || typeof change !== 'object' || Array.isArray(change)) { problems.push(`${at} is not an object`); return; }
    if (!CHANGE_OPS.includes(change.op)) { problems.push(`${at}: op is one of ${CHANGE_OPS.join(', ')}`); return; }
    const extra = Object.keys(change).filter(key => !CHANGE_KEYS[change.op].includes(key));
    if (extra.length) problems.push(`${at}: ${change.op} has no field ${extra.join(', ')}`);
    if (change.op === 'create') {
      textOk(at, 'title', change.title, CHANGE_LIMITS.title, { required: true });
      textOk(at, 'description', change.description, CHANGE_LIMITS.description);
      if (change.type !== undefined && !CHANGE_TYPES.includes(change.type)) problems.push(`${at}: type is one of ${CHANGE_TYPES.join(', ')}`);
      if (change.parent !== undefined) beadOk(at, 'parent', change.parent, index);
      labelsOk(at, 'labels', change.labels);
      made.add(index + 1);
    } else if (change.op === 'update') {
      beadOk(at, 'bead', change.bead, index);
      textOk(at, 'title', change.title, CHANGE_LIMITS.title);
      textOk(at, 'description', change.description, CHANGE_LIMITS.description);
      if (change.title === undefined && change.description === undefined) problems.push(`${at}: update changes a title or a description`);
    } else if (change.op === 'dep') {
      beadOk(at, 'bead', change.bead, index);
      beadOk(at, 'blocks', change.blocks, index);
      if (change.bead === change.blocks) problems.push(`${at}: a bead cannot block itself`);
    } else if (change.op === 'close') {
      beadOk(at, 'bead', change.bead, index);
      textOk(at, 'reason', change.reason, CHANGE_LIMITS.reason, { required: true });
    } else if (change.op === 'label') {
      beadOk(at, 'bead', change.bead, index);
      labelsOk(at, 'add', change.add);
      labelsOk(at, 'remove', change.remove);
      if (change.add === undefined && change.remove === undefined) problems.push(`${at}: label adds or removes at least one label`);
    } else if (typeof change.card !== 'string' || !CHANGE_CARD.test(change.card)) {
      problems.push(`${at}: card is assistant/<folder>`);
    }
  });
  return problems;
}

/** The Design review rows of a valid change list: `{ id: 'd<n>', text, detail? }`, text up to 200 and detail up to 500 characters. */
export function changeRows(changes) {
  const clipText = (value, max) => { const flat = String(value ?? '').replace(/\s+/g, ' ').trim(); return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat; };
  const where = value => (/^#\d+$/.test(value) ? `new item ${value.slice(1)}` : value);
  return changes.map((change, index) => {
    let text;
    let detail = '';
    if (change.op === 'create') {
      text = `Add ${change.type ?? 'task'} "${clipText(change.title, 120)}"${change.parent ? ` under ${where(change.parent)}` : ''}`;
      detail = [change.description ? clipText(change.description, 400) : '', change.labels?.length ? `Labels: ${change.labels.join(', ')}` : ''].filter(Boolean).join(' · ');
    } else if (change.op === 'update') {
      text = `Change ${where(change.bead)}${change.title !== undefined ? ` to "${clipText(change.title, 120)}"` : ''}`;
      detail = change.description !== undefined ? `New description: ${clipText(change.description, 400)}` : '';
    } else if (change.op === 'dep') {
      text = `${where(change.bead)} must be done before ${where(change.blocks)}`;
    } else if (change.op === 'close') {
      text = `Close ${where(change.bead)}`;
      detail = `Reason: ${clipText(change.reason, 200)}`;
    } else if (change.op === 'label') {
      text = `Labels on ${where(change.bead)}`;
      detail = [change.add?.length ? `Add: ${change.add.join(', ')}` : '', change.remove?.length ? `Remove: ${change.remove.join(', ')}` : ''].filter(Boolean).join(' · ');
    } else {
      text = `Copy the card ${change.card} into this project's section`;
    }
    return { id: `d${index + 1}`, text: clipText(text, 200), ...(detail ? { detail: clipText(detail, 500) } : {}) };
  });
}
// --- ask-changes:end ---

// --- prose-command:start (self-contained: scripts/cards.test.mjs loads this block on its own) ---
/**
 * The command-looking part of a text, or null. Narrow on purpose: a false refusal blocks an agent.
 * Matches a backtick span that starts with a command word and has arguments, or has a flag; and what follows a
 * "Run:" style lead-in when it starts with a command word or a path. Text inside ``` fences is skipped.
 * Ids, names, URLs, a lone tool name and prose that only mentions a tool do not match.
 */
function proseCommand(text) {
  if (typeof text !== 'string') return null;
  const words = 'git|npm|npx|node|python|py|pwsh|powershell|cd|ssh|scp|curl|gh|bd|claude|docker|systemctl|pct|unity';
  const startsLikeCommand = new RegExp(`^(?:${words})\\s+\\S`);
  const scriptPath = /^\.[\\/]\S*(?:\.(?:ps1|sh|mjs|js|py|cmd|bat)\b|\s+\S)/;
  const flag = /\s--?[A-Za-z][\w-]*/;
  const proseSecond = /^(?:is|are|was|were|will|would|should|can|could|to|and|or|the|a|an|from|in|on|at|of|you|it|that|this|has|have|not|if|when|as|for|with|again|first|now|once|then|next|also|before|after|please|manually)$/i;
  // A program named by a hyphen, a dot or a path ("pixel-studio-comfy", "install.ps1", "tools/run") followed by an argument.
  const namedProgram = /^(?:[A-Za-z]\w*-[\w-]*\w|[\w-]+\.[A-Za-z0-9]{1,4}|[\w.~-]*[\\/][\w.\\/~-]*\w)$/;
  const outside = text.replace(/```[\s\S]*?(?:```|$)/g, ' ');
  for (const span of outside.matchAll(/`([^`\n]+)`/g)) {
    const body = span[1].trim();
    if (/^https?:\/\//i.test(body)) continue;
    if (scriptPath.test(body) || (/\s/.test(body) && (startsLikeCommand.test(body) || flag.test(body)))) return body;
  }
  for (const lead of outside.matchAll(/(?:\bRun:|\bRun `|\bIn PowerShell:|\bIn Git Bash:|\bOver SSH:|\bIn a terminal:)[ \t]*`?([^`\n]*)/gi)) {
    const rest = lead[1].trim();
    const [first = '', second = ''] = rest.split(/\s+/);
    if (new RegExp(`^(?:${words})$`).test(first) && second && !proseSecond.test(second)) return rest;
    if (/^(?:[A-Za-z]:\\\S|~\/\S|\/\S+\/\S)/.test(first)) return rest;
    if (namedProgram.test(first) && second && !proseSecond.test(second)) return `${first} ${second.replace(/[.,;]+$/, '')}`;
  }
  return null;
}
// --- prose-command:end ---
