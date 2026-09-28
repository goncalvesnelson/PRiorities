import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionOrigin = 'chrome-extension://bjmajanmepopjciklnijlfbdpafokfpe/';

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function executable(candidate) {
  await access(candidate, constants.X_OK);
  return realpath(candidate);
}

async function findExecutable(provider) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try { return await executable(join(directory, provider)); } catch {}
  }
  return undefined;
}

export async function installNativeHost({ provider = 'codex', browserProfileDirectory, hostDirectory, executablePath, nodePath = process.execPath } = {}) {
  if (!['codex', 'claude'].includes(provider)) throw new Error('Unsupported review provider.');
  if (process.platform !== 'darwin' && !browserProfileDirectory) throw new Error('This installer currently supports macOS Chrome.');
  if (executablePath && !isAbsolute(executablePath)) throw new Error('The CLI executable path must be absolute.');
  if (!isAbsolute(nodePath)) throw new Error('The Node executable path must be absolute.');
  const installedExecutablePath = executablePath ? await executable(executablePath) : await findExecutable(provider);
  if (!installedExecutablePath) throw new Error(`${provider} was not found on PATH. Install the CLI, sign in, and run this installer again.`);
  const installedNodePath = await executable(nodePath);
  const profileDirectory = resolve(browserProfileDirectory ?? join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome'));
  const installDirectory = resolve(hostDirectory ?? (browserProfileDirectory ? join(profileDirectory, 'ReviewFocusNativeHost') : join(homedir(), 'Library', 'Application Support', 'Review Focus', 'native-host')));
  const manifestDirectory = join(profileDirectory, 'NativeMessagingHosts');
  await mkdir(installDirectory, { recursive: true, mode: 0o700 });
  await chmod(installDirectory, 0o700);
  await mkdir(manifestDirectory, { recursive: true });
  const scriptPath = join(installDirectory, 'host.mjs');
  await copyFile(new URL('./native-host/host.mjs', import.meta.url), scriptPath);
  await chmod(scriptPath, 0o600);
  const launcherPath = join(installDirectory, `review-focus-${provider}`);
  const launcher = [
    '#!/bin/sh',
    `export PATH=${shellQuote(`${dirname(installedNodePath)}:${process.env.PATH ?? '/usr/bin:/bin'}`)}`,
    ...(provider === 'codex' && process.env.CODEX_HOME ? [`export CODEX_HOME=${shellQuote(process.env.CODEX_HOME)}`] : []),
    ...(provider === 'claude' && process.env.CLAUDE_CONFIG_DIR ? [`export CLAUDE_CONFIG_DIR=${shellQuote(process.env.CLAUDE_CONFIG_DIR)}`] : []),
    `exec ${shellQuote(installedNodePath)} ${shellQuote(scriptPath)} ${shellQuote(provider)} ${shellQuote(installedExecutablePath)} "$@"`, ''
  ].join('\n');
  await writeFile(launcherPath, launcher, { mode: 0o700 });
  await chmod(launcherPath, 0o700);
  const hostName = `com.review_focus.${provider}`;
  const manifestPath = join(manifestDirectory, `${hostName}.json`);
  await writeFile(manifestPath, `${JSON.stringify({ name: hostName, description: `PRiorities local ${provider === 'claude' ? 'Claude Code' : 'Codex'} helper`, path: launcherPath, type: 'stdio', allowed_origins: [extensionOrigin] }, null, 2)}\n`, { mode: 0o600 });
  return { manifestPath, launcherPath, scriptPath, provider, executablePath: installedExecutablePath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let installedCount = 0;
    for (const provider of ['codex', 'claude']) {
      const executablePath = await findExecutable(provider);
      if (!executablePath) {
        console.log(`Skipped ${provider}: CLI not found on PATH.`);
        continue;
      }
      const installed = await installNativeHost({ provider, executablePath });
      installedCount++;
      console.log(`Installed Chrome registration: ${installed.manifestPath}\nInstalled helper: ${installed.launcherPath}`);
    }
    if (!installedCount) throw new Error('No supported CLI was found on PATH. Install Codex or Claude Code, sign in, and run this installer again.');
    console.log('Reload the extension, select a provider in Settings, and check its connection.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
