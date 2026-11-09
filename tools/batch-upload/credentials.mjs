// Operating-system credential store only. There is no file, environment, or argv fallback.
import { spawnSync } from 'node:child_process';

export const SERVICE = 'arenaofbias-batch';

function missing(result) {
  return Boolean(result.error && result.error.code === 'ENOENT');
}

export function storeAvailable() {
  if (process.platform === 'linux') return !missing(spawnSync('secret-tool', ['search', 'service', SERVICE], { stdio: 'ignore' }));
  if (process.platform === 'darwin') return !missing(spawnSync('security', ['help'], { stdio: 'ignore' }));
  if (process.platform === 'win32') return !missing(spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }));
  return false;
}

export function assertStore() {
  if (!storeAvailable()) throw new Error('系统凭据库不可用，已拒绝继续');
}

function run(command, args, input) {
  const result = spawnSync(command, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) throw new Error('系统凭据库拒绝了这次读写');
  return result.stdout ?? '';
}

export function storeSecret(account, secret) {
  assertStore();
  if (typeof secret !== 'string' || !secret) throw new Error('系统凭据库拒绝了这次读写');
  if (process.platform === 'linux') {
    run('secret-tool', ['store', '--label', 'arenaofbias batch', 'service', SERVICE, 'account', account], secret);
    return;
  }
  if (process.platform === 'darwin') {
    // The system tool only accepts the secret as an argument. It is not printed.
    const result = spawnSync('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', secret], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('系统凭据库拒绝了这次读写');
    return;
  }
  const script = [
    '$secret = [Console]::In.ReadToEnd()',
    '$vault = New-Object Windows.Security.Credentials.PasswordVault',
    `$existing = @($vault.RetrieveAll() | Where-Object { $_.Resource -eq '${SERVICE}' -and $_.UserName -eq $env:AOB_ACCOUNT })`,
    'foreach ($item in $existing) { $vault.Remove($item) }',
    `$cred = New-Object Windows.Security.Credentials.PasswordCredential('${SERVICE}', $env:AOB_ACCOUNT, $secret)`,
    '$vault.Add($cred)',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    input: secret, encoding: 'utf8', env: { ...process.env, AOB_ACCOUNT: account },
  });
  if (result.status !== 0) throw new Error('系统凭据库拒绝了这次读写');
}

export function readSecret(account) {
  assertStore();
  if (process.platform === 'linux') {
    const result = spawnSync('secret-tool', ['lookup', 'service', SERVICE, 'account', account], { encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout) throw new Error('系统凭据库里没有这次批次的授权');
    return result.stdout.replace(/\r?\n$/, '');
  }
  if (process.platform === 'darwin') {
    const result = spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], { encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout) throw new Error('系统凭据库里没有这次批次的授权');
    return result.stdout.replace(/\r?\n$/, '');
  }
  const script = [
    '$vault = New-Object Windows.Security.Credentials.PasswordVault',
    `$cred = $vault.Retrieve('${SERVICE}', $env:AOB_ACCOUNT)`,
    '$cred.Password',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8', env: { ...process.env, AOB_ACCOUNT: account },
  });
  if (result.status !== 0 || !result.stdout) throw new Error('系统凭据库里没有这次批次的授权');
  return result.stdout.replace(/\r?\n$/, '');
}

export function deleteSecret(account) {
  if (!storeAvailable()) return;
  if (process.platform === 'linux') {
    spawnSync('secret-tool', ['clear', 'service', SERVICE, 'account', account], { stdio: 'ignore' });
  } else if (process.platform === 'darwin') {
    spawnSync('security', ['delete-generic-password', '-s', SERVICE, '-a', account], { stdio: 'ignore' });
  }
}
