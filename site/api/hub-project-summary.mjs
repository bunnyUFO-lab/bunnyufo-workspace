// One line per project for the Projects list: how many tasks are done of all, and the title of the milestone the work is in now.
// Pure. It reads the same Beads copy as the Roadmap, with no events, asks or sprints, so one project costs one read and a few loops.
import { buildMap } from './hub-map.mjs';

const tasksOf = milestone => milestone.features.flatMap(feature => feature.tasks);
/** A deferred task that is not closed is later work: it counts in the total and is never the work in hand. */
const isLater = task => task.state !== 'done' && task.status === 'deferred';

/**
 * @returns {{ id: string, done: number, total: number, now: string | null }}
 */
export function projectSummary({ project, meta = null, issues = [], now = new Date() }) {
  const map = buildMap({ project, meta, issues, now });
  const tasks = map.milestones.flatMap(tasksOf);
  // A milestone the map made up for loose tasks has `~` in its id: it is never "now".
  const current = map.milestones.find(milestone => !milestone.id.includes('~') && tasksOf(milestone).some(task => task.state !== 'done' && !isLater(task)));
  return { id: project, done: tasks.filter(task => task.state === 'done').length, total: tasks.length, now: current?.title ?? null };
}
