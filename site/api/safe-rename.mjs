// Replace a file by renaming a finished temp file over it, the atomic way, but patient on Windows:
// an indexer, an antivirus scan or a reader that has the target open makes rename fail for a moment
// with EPERM, EBUSY or EACCES. Try again a few times (about 0.3 s in all), then give up with the
// original error and remove the temp file, so a failed write leaves nothing behind.
import { rename as fsRename, rm } from 'node:fs/promises';

export const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
export const TRIES = 8;
export const WAIT_MS = 40;

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** `rename(temp, target)` with retries. `fs.rename`, `fs.rm` and `sleep` can be swapped for tests. */
export async function renameOver(temp, target, { rename = fsRename, remove = file => rm(file, { force: true }), sleep = pause } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temp, target);
      return;
    } catch (error) {
      if (!BUSY_CODES.has(error?.code) || attempt >= TRIES) {
        await Promise.resolve(remove(temp)).catch(() => {});
        throw error;
      }
      await sleep(WAIT_MS);
    }
  }
}
