// `multidsh-host init`: join a pool as a host and persist the sidecar config.

import { normalizeBaseUrl } from '../../protocol/index.js';
import { defaultConfigPath, saveConfig } from './config.js';
import { machineIdentity } from './machine.js';

export async function initHost(options) {
  const {
    directoryUrl,
    poolCode,
    name,
    platform = process.platform,
    version = '0.1.0',
    publicUrl,
    adminPort,
    dshPort,
    dshBin,
    dshHome,
    nodeBin,
    configPath = defaultConfigPath(),
  } = options;
  const identity = machineIdentity();
  const machineId = String(options.machineId || identity.id);
  const machineName = String(options.machineName || identity.name);

  const base = normalizeBaseUrl(directoryUrl);
  const res = await fetch(`${base}/api/pools/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: poolCode,
      kind: 'host',
      name,
      platform,
      version,
      machineId,
      machineName,
      publicUrl: normalizeBaseUrl(publicUrl),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.deviceToken) {
    const code = body?.error?.code || `http_${res.status}`;
    const message = body?.error?.message || res.statusText;
    throw new Error(`join failed: ${code} (${message})`);
  }

  const config = {
    directoryUrl: base,
    poolId: body.device.poolId,
    deviceId: body.device.id,
    deviceToken: body.deviceToken,
    pairSecret: body.pairSecret,
    name,
    platform,
    version,
    machineId,
    machineName,
    adminPort: Number(adminPort),
    dshPort: Number(dshPort),
    publicUrl: normalizeBaseUrl(publicUrl),
    dshBin,
    dshHome: dshHome || null,
    nodeBin: nodeBin || null,
    status: body.device.status,
    createdAt: Date.now(),
  };
  const file = saveConfig(config, configPath);
  return { config, file };
}
