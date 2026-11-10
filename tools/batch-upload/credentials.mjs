// Operating-system credential store only. There is no file, environment, or argv fallback.
// The secret is passed on stdin. macOS `security` has no supported "password file" flag;
// `-w` with no value prompts and reads stdin twice (value, then confirmation). A measured
// limit of that prompt is about 128 bytes, and a mismatched prompt can store an empty
// item while still exiting 0, so this tool refuses longer secrets and reads the item back.
import { spawnSync } from 'node:child_process';

export const SERVICE = 'arenaofbias-batch';
export const MAX_DARWIN_SECRET_BYTES = 127;
const ACCOUNT = /^(device|grant):[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const WINDOWS_DELETE = [
  '$ErrorActionPreference = "Stop"',
  '$vault = New-Object Windows.Security.Credentials.PasswordVault',
  '$existing = @($vault.RetrieveAll() | Where-Object { $_.Resource -eq $env:AOB_SERVICE -and $_.UserName -eq $env:AOB_ACCOUNT })',
  'foreach ($item in $existing) { $vault.Remove($item) }',
].join('\n');

const WINDOWS_STORE = [
  '$secret = [Console]::In.ReadToEnd()',
  '$vault = New-Object Windows.Security.Credentials.PasswordVault',
  '$existing = @($vault.RetrieveAll() | Where-Object { $_.Resource -eq $env:AOB_SERVICE -and $_.UserName -eq $env:AOB_ACCOUNT })',
  'foreach ($item in $existing) { $vault.Remove($item) }',
  '$cred = New-Object Windows.Security.Credentials.PasswordCredential($env:AOB_SERVICE, $env:AOB_ACCOUNT, $secret)',
  '$vault.Add($cred)',
].join('\n');

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

function refuse() {
  throw new Error('系统凭据库拒绝了这次读写');
}

function assertAccount(account) {
  if (typeof account !== 'string' || !ACCOUNT.test(account)) refuse();
}

function assertSecret(secret) {
  if (typeof secret !== 'string' || !secret || secret.includes('\0')) refuse();
}

// Pure description of the process spawn. Tests assert the secret is absent from argv.
export function planCredentialCall(platform, action, account, secret) {
  assertAccount(account);
  if (platform === 'linux' && action === 'store') {
    assertSecret(secret);
    return {
      command: 'secret-tool',
      args: ['store', '--label', 'arenaofbias batch', 'service', SERVICE, 'account', account],
      input: secret,
    };
  }
  if (platform === 'linux' && action === 'delete') {
    return { command: 'secret-tool', args: ['clear', 'service', SERVICE, 'account', account], input: null };
  }
  if (platform === 'darwin' && action === 'store') {
    assertSecret(secret);
    if (secret.includes('\n') || secret.includes('\r')) refuse();
    if (Buffer.byteLength(secret) > MAX_DARWIN_SECRET_BYTES) refuse();
    return {
      command: 'security',
      // `-w` is last and has no value, so security prompts instead of taking argv.
      args: ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w'],
      input: `${secret}\n${secret}\n`,
    };
  }
  if (platform === 'darwin' && action === 'delete') {
    return { command: 'security', args: ['delete-generic-password', '-s', SERVICE, '-a', account], input: null };
  }
  if (platform === 'win32' && (action === 'store' || action === 'delete')) {
    if (action === 'store') assertSecret(secret);
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-Command', action === 'store' ? WINDOWS_STORE : WINDOWS_DELETE],
      input: action === 'store' ? secret : null,
      env: { AOB_ACCOUNT: account, AOB_SERVICE: SERVICE },
    };
  }
  refuse();
}

function runPlanned(planned) {
  const result = spawnSync(planned.command, planned.args, {
    input: planned.input ?? undefined,
    encoding: 'utf8',
    env: planned.env ? { ...process.env, ...planned.env } : process.env,
  });
  if (result.error || result.status !== 0) refuse();
  return result.stdout ?? '';
}

export function storeSecret(account, secret) {
  assertStore();
  const planned = planCredentialCall(process.platform, 'store', account, secret);
  runPlanned(planned);
  if (process.platform === 'darwin') {
    let got = '';
    try { got = readSecret(account); } catch { got = ''; }
    if (got !== secret) {
      deleteSecret(account);
      refuse();
    }
  }
}

export function readSecret(account) {
  assertStore();
  assertAccount(account);
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
    '$cred = $vault.Retrieve($env:AOB_SERVICE, $env:AOB_ACCOUNT)',
    '$cred.Password',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8', env: { ...process.env, AOB_ACCOUNT: account, AOB_SERVICE: SERVICE },
  });
  if (result.status !== 0 || !result.stdout) throw new Error('系统凭据库里没有这次批次的授权');
  return result.stdout.replace(/\r?\n$/, '');
}

export function deleteSecret(account) {
  if (!storeAvailable()) return;
  let planned;
  try { planned = planCredentialCall(process.platform, 'delete', account); }
  catch { return; }
  spawnSync(planned.command, planned.args, {
    input: planned.input ?? undefined,
    encoding: 'utf8',
    stdio: ['pipe', 'ignore', 'ignore'],
    env: planned.env ? { ...process.env, ...planned.env } : process.env,
  });
}
