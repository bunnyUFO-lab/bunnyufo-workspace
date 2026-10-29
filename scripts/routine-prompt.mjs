#!/usr/bin/env node
// Prints the cloud routine's fixed prompt: the text between the markers in docs/cloud-routines.md.
// Exit 1 when a marker is missing. The routines API gets this output, never a command that prints it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const START = '<!-- routine-prompt:start -->';
export const END = '<!-- routine-prompt:end -->';
export const DOC = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'cloud-routines.md');

/** The prompt text of a doc, or null when a marker is missing or the markers are out of order. */
export function extractPrompt(raw) {
  const doc = raw.replace(/\r\n/g, '\n');   // a Windows checkout may have CRLF
  const from = doc.indexOf(START);
  const to = doc.indexOf(END);
  if (from < 0 || to < from) return null;
  return doc.slice(from + START.length, to).replace(/^\r?\n/, '').replace(/\s+$/, '') + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const prompt = extractPrompt(readFileSync(DOC, 'utf8'));
  if (prompt === null) {
    console.error(`${DOC}: the ${START} / ${END} markers are missing.`);
    process.exit(1);
  }
  process.stdout.write(prompt);
}
