// Renders a card's gallery/gallery.json (written by tools/gpu/guard.mjs) as a
// portable Markdown page body: newest jobs first, one image table per job.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const PER_ROW = 4;
const cell = value => String(value ?? '').replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();

export function renderGallery(data) {
  const entries = [...(data?.entries ?? [])].sort((a, b) => String(b.created).localeCompare(String(a.created)));
  const lines = [
    '# Gallery',
    '',
    'Sprites, tiles and animations generated through the agent tools, newest first.',
    'Asset IDs can be pasted into a follow-up request. This page is generated from',
    '`gallery/gallery.json`; run `npm run docs:sync` to refresh it after new jobs.',
    '',
  ];
  if (!entries.length) {
    lines.push('No generations yet. Ask an agent, for example: "Using Sprite Studio, generate four 32px sprites of a cave goblin."', '');
    return lines.join('\n');
  }
  for (const entry of entries) {
    const params = entry.params ?? {};
    const details = [entry.op, params.pixels && `${params.pixels}px`, params.tile_size && `${params.tile_size}px tiles`,
      params.view, params.motion, String(entry.created ?? '').replace('T', ' ')].filter(Boolean).join(' · ');
    lines.push(`## ${cell(entry.prompt || entry.title || entry.op)}`, '', `${details} · job \`${entry.job_id}\``, '');
    const assets = entry.assets ?? [];
    for (let start = 0; start < assets.length; start += PER_ROW) {
      const row = assets.slice(start, start + PER_ROW);
      lines.push(`| ${row.map(asset => cell(asset.title || asset.kind)).join(' | ')} |`);
      lines.push(`| ${row.map(() => '---').join(' | ')} |`);
      lines.push(`| ${row.map(asset => `![${cell(`${asset.title || asset.kind} (${asset.id})`)}](gallery/${asset.file})`).join(' | ')} |`);
      lines.push(`| ${row.map(asset => [`\`${asset.id}\``, asset.status || 'draft', asset.w && asset.h ? `${asset.w}×${asset.h}` : ''].filter(Boolean).join(' · ')).join(' | ')} |`);
      lines.push('');
    }
    const palettes = assets.filter(asset => Array.isArray(asset.palette) && asset.palette.length);
    if (palettes.length) {
      lines.push('Palettes:', '');
      for (const asset of palettes) lines.push(`- \`${asset.id}\`: ${asset.palette.slice(0, 24).join(' ')}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

export async function readGallery(cardFolder) {
  try { return JSON.parse(await readFile(path.join(cardFolder, 'gallery', 'gallery.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
