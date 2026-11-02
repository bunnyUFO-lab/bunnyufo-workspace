// A mixed Needs you queue for the badge tests and the PR screenshots: every type, every Question kind and every Steps kind.
// Seeds the fixture's fake bucket only; nothing real is read or written.
import { askJson, checklistJson, designAskJson, eventJson, minutesAgo, playtestJson, plainOptions } from '../../site/api/test/hub-fixtures.mjs';

const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
export const idOf = (project, slug, tail) => `${day}-${project}-${slug}-${tail}`;

/** The titles by what each is meant to show; the tests look rows up by them. */
export const TITLES = {
  askApproval: 'Merge the wall-jump stack?',
  askVerify: 'Did the live deploy come up?',
  askDesign: 'Which title screen reads better?',
  askDecision: 'Keep the dash or drop it?',
  askGuessed: 'Is the Discord bot working now?',
  askPasskey: 'Spend 40 credits on the cloud run?',
  designReview: 'Review the wood card frame',
  stepsVerify: 'Live check the new menu',
  stepsSetup: 'Install the Windows build tools',
  stepsInvestigate: 'Investigate why saves hang',
  stepsDevelop: 'Build the tutorial level',
  stepsGuessed: 'Paste the API key into the bot',
  playtest: 'Play the wall-jump build',
  review: 'PR ready for review: gate script',
  blocked: 'Permission needed: run the sprite batch',
  request: 'Look at the gate script',
  hermesAsks: 'Research which game',
};

export function seedMixed(fixture) {
  const { seed, now } = fixture;
  const ask = (project, slug, tail, minutes, extra) => {
    const id = idOf(project, slug, tail);
    seed.ask(askJson({ id, project, now: minutesAgo(now, minutes), options: plainOptions().slice(0, 2), allowDrawing: false, ...extra }));
    return id;
  };
  const list = (project, slug, tail, minutes, extra) => {
    const id = idOf(project, slug, tail);
    seed.checklist(checklistJson({ id, project, now: minutesAgo(now, minutes), ...extra }));
    return id;
  };
  const ids = {};
  ids.askApproval = ask('magic-loops', 'merge', 'a001', 5, { question: TITLES.askApproval, kind: 'approval', requirePasskey: true });
  ids.askVerify = ask('magic-loops', 'deploy', 'a002', 9, { question: TITLES.askVerify, kind: 'verify' });
  ids.askDesign = ask('sprite-studio', 'title', 'a003', 14, { question: TITLES.askDesign, kind: 'design' });
  ids.askDecision = ask('magic-loops', 'dash', 'a004', 20, { question: TITLES.askDecision, kind: 'decision' });
  ids.askGuessed = ask('bunnylink', 'bot', 'a005', 25, { question: TITLES.askGuessed });
  ids.askPasskey = ask('bunnylink', 'spend', 'a006', 28, { question: TITLES.askPasskey, requirePasskey: true });
  ids.designReview = idOf('sprite-studio', 'frame', 'a007');
  seed.ask(designAskJson({ id: ids.designReview, project: 'sprite-studio', now: minutesAgo(now, 33), question: TITLES.designReview }));
  ids.stepsVerify = list('magic-loops', 'menu', 'c001', 40, { title: TITLES.stepsVerify, kind: 'verify' });
  ids.stepsSetup = list('bunnylink', 'tools', 'c002', 44, { title: TITLES.stepsSetup, kind: 'setup' });
  ids.stepsInvestigate = list('magic-loops', 'saves', 'c003', 48, { title: TITLES.stepsInvestigate, kind: 'investigate' });
  ids.stepsDevelop = list('sprite-studio', 'level', 'c004', 52, { title: TITLES.stepsDevelop, kind: 'develop' });
  ids.stepsGuessed = list('bunnylink', 'key', 'c005', 56, { title: TITLES.stepsGuessed });
  const playId = idOf('magic-loops', 'wall-jump', 'c006');
  seed.checklist(playtestJson({ id: playId, project: 'magic-loops', now: minutesAgo(now, 60), title: TITLES.playtest }));
  ids.playtest = playId;
  seed.event(eventJson({ kind: 'ready-for-review', ts: minutesAgo(now, 64), project: 'bunnylink', bead: 'bl-9a2', title: TITLES.review, url: 'https://example.test/pr/7' }));
  seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(now, 68), project: 'sprite-studio', session: 'sess-ss', title: TITLES.blocked, source: 'hub-hooks', extra: { reason: 'permission' } }));
  const request = idOf('bunnylink', 'look-at-the-gate', 'e5e5');
  seed.request({ id: request, project: 'bunnylink', createdAt: minutesAgo(now, 72).toISOString(), by: 'owner', text: TITLES.request, preset: 'code-task', repo: 'example/bunnylink', target: 'at-pc', origin: { kind: 'owner', name: 'owner' } });
  ids.request = request;
  const asking = idOf('magic-loops', 'research', 'f6f6');
  seed.request({ id: asking, project: 'magic-loops', createdAt: minutesAgo(now, 80).toISOString(), by: 'owner', text: TITLES.hermesAsks, preset: 'research', target: 'hermes', origin: { kind: 'owner', name: 'owner' } });
  seed.put(`requests/${asking}/approved.json`, { v: 1, request: asking, project: 'magic-loops', repo: null, target: 'hermes', limits: { minutes: 30 }, expires: '9999-12-31T00:00:00Z', at: minutesAgo(now, 79).toISOString(), by: 'owner', signature: 'x' });
  seed.put(`requests/${asking}/taken.json`, { runner: 'hermes', host: 'hub', nonce: 'n', at: minutesAgo(now, 78).toISOString() });
  seed.put(`requests/${asking}/result.json`, { v: 1, outcome: 'question', question: 'Which of the two games do you mean?', summary: 'Two games.', by: 'hub', at: minutesAgo(now, 2).toISOString() });
  ids.hermesAsks = asking;
  return ids;
}
