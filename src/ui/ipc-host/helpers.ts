import type * as fsModule from 'node:fs';
import type * as fsPromisesModule from 'node:fs/promises';

export type FsWithPromises = typeof fsModule & { promises: typeof fsPromisesModule };

export function createHostStatusHelpers(
  fs: FsWithPromises,
  settingsFile: string,
  configFile: string,
  sidecarLogFile: string,
) {
  let disabledCache: { value: boolean; at: number; pending: Promise<boolean> | null } = {
    value: false,
    at: 0,
    pending: null,
  };
  let fallbackCache: { endpoint: string | null; at: number; pending: Promise<string | null> | null } = {
    endpoint: null,
    at: 0,
    pending: null,
  };

  const isDisabled = async (): Promise<boolean> => {
    const now = Date.now();
    if (now - disabledCache.at < 1000) return disabledCache.value;
    if (disabledCache.pending) return disabledCache.pending;
    disabledCache.pending = (async () => {
      const readJson = async (file: string): Promise<Record<string, unknown> | null> => {
        try {
          return JSON.parse(
            (await fs.promises.readFile(file, 'utf8')).replace(/^\uFEFF/, ''),
          ) as Record<string, unknown>;
        } catch {
          return null;
        }
      };
      const [settings, config] = await Promise.all([readJson(settingsFile), readJson(configFile)]);
      const plugins = config?.plugins as Record<string, { enabled?: boolean } | undefined> | undefined;
      const disabled =
        settings?.enabled === false || plugins?.['antigravity-pulse']?.enabled === false;
      disabledCache = { value: disabled, at: Date.now(), pending: null };
      return disabled;
    })().finally(() => {
      if (disabledCache.pending) disabledCache.pending = null;
    });
    return disabledCache.pending;
  };

  const readLogTail = async (file: string, maxBytes = 262144): Promise<string> => {
    const stat = await fs.promises.stat(file);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    if (!length) return '';
    const handle = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(buf, offset, length - offset, start + offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
      }
      return buf.toString('utf8', 0, offset);
    } finally {
      await handle.close();
    }
  };

  const getFallbackEndpoint = async (): Promise<string | null> => {
    const now = Date.now();
    if (fallbackCache.endpoint && now - fallbackCache.at < 1500) return fallbackCache.endpoint;
    if (fallbackCache.pending) return fallbackCache.pending;
    fallbackCache.pending = (async () => {
      let endpoint: string | null = null;
      try {
        const log = await readLogTail(sidecarLogFile);
        const port = [...log.matchAll(/\[sidecar\] listening on 127\.0\.0\.1:(\d+)/g)].at(-1)?.[1];
        if (port) endpoint = `http://127.0.0.1:${port}/`;
      } catch {
        // Ignore missing or unreadable sidecar log files.
      }
      fallbackCache = { endpoint, at: Date.now(), pending: null };
      return endpoint;
    })().finally(() => {
      if (fallbackCache.pending) fallbackCache.pending = null;
    });
    return fallbackCache.pending;
  };

  const resetFallbackEndpoint = (): void => {
    fallbackCache = { endpoint: null, at: 0, pending: null };
  };

  return { isDisabled, getFallbackEndpoint, resetFallbackEndpoint };
}
