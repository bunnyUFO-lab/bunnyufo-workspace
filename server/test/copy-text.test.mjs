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
  ];
  for (const lines of kept) assert.equal(copyText(block(lines), 'powershell').oneLine, false, lines.join(' / '));
});

test('a session opened before the last line keeps the block as shown; one opened last still joins', () => {
  for (const first of ['ssh root@host.example.test', 'Enter-PSSession -ComputerName box', 'docker exec -it web sh', 'wsl', 'python']) {
    assert.equal(copyText(block([first, 'ls']), 'powershell').oneLine, false, first);
  }
  assert.deepEqual(copyText(block(['cd C:\\x', 'ssh root@host.example.test']), 'powershell'), { text: 'cd C:\\x; ssh root@host.example.test', oneLine: true });
});
