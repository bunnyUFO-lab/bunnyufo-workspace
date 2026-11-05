// Agent writes in project sections, made by the real card API handler over a stand-in S3, for the UI tests and the
// screenshots of the Hub's rows, Revert and setting. Section `one` is the fixture's own workspace (its card `hub`); section
// `lanes` is the project the Work fixture makes. Nothing here reaches a real bucket.
import { createHash } from 'node:crypto';
import { createBucket } from '../../site/api/s3.mjs';
import { createCardApi, parseTokens } from '../../site/card-api/handler.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const md5 = text => createHash('md5').update(text).digest('hex');

export const HUB_CARD = { id: 'hub', folder: 'hub', title: 'The hub card', description: 'A card.', category: 'test', created: '2026-11-01', updated: '2026-11-01', status: 'active', type: 'standalone', steps: [{ name: 'Notes', path: 'index.md' }] };
export const LANES_CARD = { id: 'lanes-plan', folder: '2026-11-01_lanes-plan', title: 'Lanes plan', description: 'The owner\'s plan.', category: 'plan', created: '2026-11-01', updated: '2026-11-01', status: 'active', type: 'standalone', steps: [{ name: 'Plan', path: 'index.md' }] };

/**
 * Seeds the two sections and the writes: in `one`, an agent's new tab on the hub card, an edit of its page (from a job) and a new
 * card with an HTML tab; in `lanes`, a new card and an edit. `at` is when the first write happened; each next one is a minute later.
 */
export async function seedAgentCards(fake, { at = Date.now() - 2 * 3_600_000, agent = 'Researcher' } = {}) {
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  let clock = at;
  const api = createCardApi({ bucket, tokens: parseTokens(`lib=${sha('tok')}:read=*;write=inbox|assistant|@library`), today: () => new Date(clock).toISOString().slice(0, 10), now: () => clock });
  const list = (section, name, entities) => fake.seed(`sections/${section}/workspace.json`, JSON.stringify({ name, entities }, null, 2), 'application/json');
  list('one', 'One', [HUB_CARD]);
  fake.seed(`sections/one/${HUB_CARD.folder}/index.md`, '# The hub card\n\nA card that happens to be called hub.\n', 'text/markdown');
  list('lanes', 'Lanes', [LANES_CARD]);
  fake.seed(`sections/lanes/${LANES_CARD.folder}/index.md`, '# Lanes plan\n', 'text/markdown');
  const call = async (method, rawPath, body, headers) => {
    clock += 60_000;
    const response = await api({ requestContext: { http: { method } }, rawPath, headers: { Authorization: 'Bearer tok', ...headers }, body });
    if (response.statusCode !== 200) throw new Error(`${method} ${rawPath}: ${response.statusCode} ${response.body}`);
    return JSON.parse(response.body);
  };
  const who = (why, extra = {}) => ({ 'x-card-agent': agent, 'x-card-why': encodeURIComponent(why), ...extra });
  const file = (section, name, text, why, extra, type = 'text/markdown') => call('PUT', `/sections/${section}/files/${name}`, text, { 'content-type': type, ...who(why, extra) });
  const entry = (section, id, card, why, batch) => call('PUT', `/sections/${section}/cards/${id}`, JSON.stringify(card), who(why, { 'x-card-batch': batch }));
  const job = '20261105-research-a1b2';
  await file('one', `${HUB_CARD.folder}/sources.md`, '# Sources\n\n- A link\n', 'Sources for the owner to check', { 'if-none-match': '*', 'x-card-batch': 'tabbatch01' });
  await entry('one', 'hub', { ...HUB_CARD, steps: [...HUB_CARD.steps, { name: 'Sources', path: 'sources.md' }] }, 'Sources for the owner to check', 'tabbatch01');
  await file('one', `${HUB_CARD.folder}/index.md`, '# The hub card\n\nA card that happens to be called hub.\n\nAgent line: checked the facts.\n', 'Fix a fact the owner flagged in this chat', { 'if-match': `"${md5('# The hub card\n\nA card that happens to be called hub.\n')}"`, 'x-card-context': `job:${job}`, 'x-card-batch': 'editbatch01' });
  await file('one', '2026-11-05_agent-page/index.html', '<!doctype html><title>Agent page</title><p>An agent made this page.</p>\n', 'A mockup to look at', { 'if-none-match': '*', 'x-card-batch': 'cardbatch01' }, 'text/html');
  await entry('one', 'agent-page', { id: 'agent-page', title: 'Agent page', description: 'A mockup.', type: 'standalone', category: 'mockup', created: '2026-11-05', folder: '2026-11-05_agent-page', steps: [{ name: 'Page', path: 'index.html' }] }, 'A mockup to look at', 'cardbatch01');
  await file('lanes', '2026-11-05_lanes-notes/index.md', '# Lane notes\n', 'Research notes for the lanes project', { 'if-none-match': '*', 'x-card-batch': 'lanecard001' });
  await entry('lanes', 'lanes-notes', { id: 'lanes-notes', title: 'Lane notes', description: 'Notes.', type: 'standalone', category: 'research', created: '2026-11-05', folder: '2026-11-05_lanes-notes', steps: [{ name: 'Notes', path: 'index.md' }] }, 'Research notes for the lanes project', 'lanecard001');
  await file('lanes', `${LANES_CARD.folder}/index.md`, '# Lanes plan\n\nAdded: a risk list.\n', 'Add the risk list the owner asked for', { 'if-match': `"${md5('# Lanes plan\n')}"`, 'x-card-context': 'chat', 'x-card-batch': 'laneedit001' });
  return { job };
}
