// A plain multi-line PowerShell block is copied as one line, so pasting it runs nothing until Enter; anything else as shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyText } from '../../src/hub/copyText.ts';

const block = lines => lines.join('\n');

test('a plain PowerShell block becomes one line joined with "; "', () => {
  const code = block(['cd C:\\Users\\owner', 'claude plugin marketplace update workspace-skills', 'claude plugin update hub-hooks@workspace-skills --scope user', 'claude plugin list']);
  assert.deepEqual(copyText(code, 'powershell'), {
    text: 'cd C:\\Users\\owner; claude plugin marketplace update workspace-skills; claude plugin update hub-hooks@workspace-skills --scope user; claude plugin list',
    oneLine: true,
  });
  for (const lang of ['pwsh', 'ps1', 'PowerShell']) assert.equal(copyText(code, lang).oneLine, true, lang);
});

test('blank lines, whole-line comments, CRLF and trailing semicolons are dropped from the joined line', () => {
  const code = '# Get the new installer\r\ncd C:\\x\r\n\r\ngit fetch;\r\ngit checkout --detach origin/main\r\n';
  assert.deepEqual(copyText(code, 'powershell'), { text: 'cd C:\\x; git fetch; git checkout --detach origin/main', oneLine: true });
});

test('the installer line with its quoted rule joins', () => {
  const code = block(['cd "$env:USERPROFILE\\.config\\pc-dispatch"', "Set-ExecutionPolicy -Scope Process Bypass -Force; .\\install.ps1 -Runs -Allow bunnylink 'Bash(git status)'"]);
  assert.equal(copyText(code, 'powershell').text, "cd \"$env:USERPROFILE\\.config\\pc-dispatch\"; Set-ExecutionPolicy -Scope Process Bypass -Force; .\\install.ps1 -Runs -Allow bunnylink 'Bash(git status)'");
});

test('a single command, another language or no language is copied as shown', () => {
  assert.deepEqual(copyText('claude plugin list', 'powershell'), { text: 'claude plugin list', oneLine: false });
  const two = block(['cd /srv', 'git pull']);
  assert.deepEqual(copyText(two, 'bash'), { text: two, oneLine: false });
  assert.deepEqual(copyText(two, ''), { text: two, oneLine: false });
  assert.deepEqual(copyText(two), { text: two, oneLine: false });
});

test('lines that belong together keep the block as shown', () => {
  const kept = [
    ['git status # what changed', 'git pull'],
    ['git commit -m "fix #3"', 'git push'],
    ['Get-ChildItem |', 'Select-Object Name'],
    ['Get-ChildItem `', '  -Recurse'],
    ['foreach ($f in $files) {', '  Remove-Item $f', '}'],
    ['$text = @"', 'two', '"@'],
    ['<#', 'notes', '#>', 'git pull'],
    ['$x =', '42'],
    // A string that spans lines (review of #122): joined, its text would change with no error.
    ['Set-Content -Path x.env -Value "A=1', 'B=2"'],
    ["Write-Output 'one", "# not a comment", "two'"],
    ['git commit -m "first line', '', 'second line"', 'git push'],
    // An operator, a bracket or a statement left open: joined, PowerShell could not parse it.
    ['if ($a -and', '$b) { "yes" }'],
    ['$n = (1 + 2', ') * 3'],
    ['$list = @(1, 2', ')'],
    ['try { Get-Item x } ', 'catch { "no" }'],
    ['if ($a) { "a" }', 'else { "b" }'],
  ];
  for (const lines of kept) assert.equal(copyText(block(lines), 'powershell').oneLine, false, lines.join(' / '));
});

test('an even number of quotes on every line still joins', () => {
  const code = block(['git commit -m "fix the jump"', "git tag 'v1'", 'git push']);
  assert.equal(copyText(code, 'powershell').text, 'git commit -m "fix the jump"; git tag \'v1\'; git push');
});

test('a session opened before the last line keeps the block as shown; one opened last still joins', () => {
  const sessions = [
    'ssh root@host.example.test', 'Enter-PSSession -ComputerName box', 'docker exec -it web sh', 'kubectl exec -ti pod -- sh',
    'wsl', 'wsl -d Ubuntu', 'claude', 'claude --model opus', 'claude.exe', 'python', 'python -i setup.py', 'py', 'node',
    'cmd', 'cmd /k echo hi', 'powershell', 'pwsh -NoExit -Command Get-Date', 'bash', 'bash -l', 'psql -U app', 'sqlite3 x.db',
  ];
  for (const first of sessions) assert.equal(copyText(block([first, 'ls']), 'powershell').oneLine, false, first);
  // Commands that run and return still join.
  for (const first of ['claude plugin list', 'claude auth status', 'claude -p "hi"', 'python tools/x.py', 'node dispatch.mjs status', 'cmd /c dir', 'bash run.sh', 'claudette']) {
    assert.equal(copyText(block([first, 'ls']), 'powershell').oneLine, true, first);
  }
  assert.deepEqual(copyText(block(['cd C:\\x', 'ssh root@host.example.test']), 'powershell'), { text: 'cd C:\\x; ssh root@host.example.test', oneLine: true });
});
