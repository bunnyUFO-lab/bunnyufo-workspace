// The UI runner stops the file it is running when it is told to stop. Quiet: the fake file only sleeps (idle timer, bounded).
// Uses the runner's --self-test-signal seam instead of a real signal, which Windows does not deliver the same way.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'run-ui-tests.mjs');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(50); }
  return null;
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  test(`${signal} stops the running UI file and the runner exits`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'buw-ui-runner-'));
    const pidFile = path.join(dir, 'pid.txt');
    // Idle for 60 s at most: if the runner fails to stop it, it still ends by itself.
    await writeFile(path.join(dir, 'sleepy-ui.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60_000);\n`);
    let childPid = 0;
    const run = spawn(process.execPath, [runner, `--self-test-signal=${signal}`], { env: { ...process.env, BUW_UI_TEST_DIR: dir }, stdio: 'ignore', windowsHide: true });
    const bound = setTimeout(() => run.kill('SIGKILL'), 30_000);
    try {
      const code = await new Promise(resolve => run.on('close', resolve));
      childPid = Number(await waitFor(async () => readFile(pidFile, 'utf8').catch(() => '')));
      assert.ok(childPid > 0, 'The fake UI file started.');
      assert.notEqual(code, 0, 'A stopped run is not a pass.');
      assert.equal(await waitFor(() => !alive(childPid), 5000), true, 'The UI file process is gone.');
    } finally {
      clearTimeout(bound);
      if (childPid && alive(childPid)) process.kill(childPid, 'SIGKILL');
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('a normal run of a quick file passes and leaves nothing running', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'buw-ui-runner-'));
  try {
    await writeFile(path.join(dir, 'quick-ui.mjs'), 'console.log("ok");\n');
    const run = spawn(process.execPath, [runner], { env: { ...process.env, BUW_UI_TEST_DIR: dir }, stdio: 'ignore', windowsHide: true });
    const bound = setTimeout(() => run.kill('SIGKILL'), 30_000);
    assert.equal(await new Promise(resolve => run.on('close', resolve)), 0);
    clearTimeout(bound);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a fragment ending in .mjs is a whole file name, and --allow-empty ends 0 when nothing matches', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'buw-ui-runner-'));
  try {
    for (const name of ['hub-ui.mjs', 'hub-work-ui.mjs']) await writeFile(path.join(dir, name), 'console.log("ran");');
    const run = args => new Promise(resolve => {
      let out = '';
      const child = spawn(process.execPath, [runner, ...args], { env: { ...process.env, BUW_UI_TEST_DIR: dir }, windowsHide: true });
      child.stdout.on('data', chunk => { out += chunk; });
      child.on('close', code => resolve({ code, out }));
    });
    const exact = await run(['hub-ui.mjs']);
    assert.equal(exact.code, 0);
    assert.match(exact.out, /1 passed, 0 failed, 1 run/);
    assert.equal((await run(['nope-ui.mjs'])).code, 1);
    assert.equal((await run(['nope-ui.mjs', '--allow-empty'])).code, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
