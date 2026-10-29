// A map model for the layout snapshot: three milestones, five features on the busiest one, tasks in every
// state with long and short titles, and two sprints. Plain data, so the same model feeds both axes.
const task = (id, title, state, signs = [], sprints = []) => ({ id, title, state, status: state, signs, deps: [], sprints, prs: [] });
const feature = (id, title, state, tasks) => ({ id, title, state, tasks });
export const snapshotModel = () => ({
  project: 'snap',
  meta: null,
  ageMinutes: null,
  milestones: [
    {
      id: 'm1', title: 'Foundations', state: 'done',
      features: [feature('m1-a', 'Project setup', 'done', [task('t1', 'Create the repository', 'done'), task('t2', 'Wire the build and the tests together', 'done')])],
    },
    {
      id: 'm2', title: 'The long milestone title that needs wrapping', state: 'doing',
      features: [
        feature('m2-a', 'Combat', 'doing', [task('t3', 'Hit boxes', 'done', ['deployed']), task('t4', 'Damage numbers that float up and fade out slowly', 'doing', ['working', 'pr']), task('t5', 'Knockback', 'next')]),
        feature('m2-b', 'A feature with a rather long title indeed', 'next', [task('t6', 'Spawn tables', 'next', ['new']), task('t7', 'Waves', 'later')]),
        feature('m2-c', 'Loot', 'later', [task('t8', 'Drop rates', 'later')]),
        feature('m2-d', 'Audio', 'you', [task('t9', 'Mix the sound effects', 'you', ['review']), task('t10', 'Music loops', 'later', ['ci-failed', 'idle'])]),
        feature('m2-e', 'Polish', 'later', []),
      ],
    },
    {
      id: 'm3', title: 'Launch', state: 'later',
      features: [feature('m3-a', 'Store page', 'later', [task('t11', 'Trailer', 'later'), task('t12', 'Screenshots', 'later')])],
    },
  ],
  sprints: [
    { name: 'Sprint 1', milestones: [{ id: 'm1', count: 2, total: 2 }, { id: 'm2', count: 1, total: 10 }] },
    { name: 'Sprint 2', milestones: [{ id: 'm2', count: 0, total: 10 }, { id: 'm3', count: 0, total: 2 }] },
  ],
});
export const everythingOpen = model => new Set(model.milestones.flatMap(m => [m.id, ...m.features.map(f => f.id)]));
