// Time limits for the browser tests, set from the machine they run on.
//
// A test written on an idle PC waits 15 s for a toast; on a PC that is also running other
// suites, builds or a game, the same wait can take longer than that and the test fails
// although nothing is wrong. Every wait in a UI test goes through `ms()`, which multiplies the
// number by BUW_UI_TIMEOUT_SCALE (default 4). A wait that is really stuck still ends: it only
// ends later, and always with a message that names the wait.
import { mkdtemp } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../../site/api/test/steady-fetch.mjs';

const scale = Number(process.env.BUW_UI_TIMEOUT_SCALE);
export const SCALE = Number.isFinite(scale) && scale > 0 ? scale : 4;
export const ms = value => Math.round(value * SCALE);

// Isolation from the machine: the service reads ~/.buw/config.json (the card API's address) and
// ~/.buw/workspaces.json (the registry) when a test does not pass its own. On the owner's PC
// those point at the real site and the real workspaces, so a test page could talk to the live
// card API, or open another checkout's data. Every UI test imports this file first, so point
// both at an empty per-run folder unless the caller already chose one.
const home = await mkdtemp(path.join(os.tmpdir(), 'buw-ui-home-'));
process.env.BUW_CONFIG ||= path.join(home, 'config.json');
process.env.BUW_REGISTRY ||= path.join(home, 'workspaces.json');
process.on('exit', () => { try { rmSync(home, { recursive: true, force: true }); } catch { /* the OS clears the temp folder */ } });
