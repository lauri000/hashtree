import type { BlossomServerConfig, ConnectivityState } from '../protocol.js';

const PROBE_TIMEOUT_MS = 3500;
const DUMMY_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

async function probe(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
    });
    return res.status >= 100;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function probeConnectivity(servers: BlossomServerConfig[]): Promise<ConnectivityState> {
  const readServers = servers.filter(server => server.read !== false);
  const writeServers = servers.filter(server => server.write);

  const [readResults, writeResults] = await Promise.all([
    Promise.all(readServers.map(server => probe(`${stripTrailingSlash(server.url)}/${DUMMY_HASH}`))),
    Promise.all(writeServers.map(server => probe(`${stripTrailingSlash(server.url)}/upload`))),
  ]);

  const reachableReadServers = readResults.filter(Boolean).length;
  const reachableWriteServers = writeResults.filter(Boolean).length;

  return {
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    reachableReadServers,
    totalReadServers: readServers.length,
    reachableWriteServers,
    totalWriteServers: writeServers.length,
    updatedAt: Date.now(),
  };
}
