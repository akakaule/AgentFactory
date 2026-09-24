import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'win32').each([
  { argument: '', expected: 'agentfactory.db' },
  { argument: '-Database ./logs/custom.db', expected: 'logs\\custom.db' },
])('ignores stale database environment and supports explicit overrides: $expected', ({ argument, expected }) => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', `
    $ErrorActionPreference = 'Stop'
    $env:AUTH_MODE = 'none'
    $env:PORT = '18787'
    $env:AGENTFACTORY_DB = 'C:\\WINDOWS\\system32\\agentfactory.db'
    [Environment]::CurrentDirectory = $env:TEMP
    function Get-NetTCPConnection { }
    function node {
      Write-Output ('DATABASE=' + $env:AGENTFACTORY_DB)
      Write-Output ('AUTH=' + $env:AUTH_MODE)
      $global:LASTEXITCODE = 0
    }
    & ./start-board.ps1 ${argument}
    Write-Output ('RESTORED_AUTH=' + $env:AUTH_MODE)
    Write-Output ('RESTORED_DB=' + $env:AGENTFACTORY_DB)
  `], { cwd: root, encoding: 'utf8' });

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(`DATABASE=${root}${expected}`);
  expect(result.stdout).toContain('AUTH=token');
  expect(result.stdout).toContain('RESTORED_AUTH=none');
  expect(result.stdout).toContain('RESTORED_DB=C:\\WINDOWS\\system32\\agentfactory.db');
});
