import type { BrowserDriverLaunchDependencies, BrowserOrigin } from '../src/proofs/did-browser/did-browser-runtime.js';

import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';

import {
  acquireServiceWorkerNetworkInspection,
  buildServiceWorkerBundle,
  didsBrowserBundle,
  launchBrowserDriver,
  startBrowserOrigin,
} from '../src/proofs/did-browser/did-browser-runtime.js';

const INSPECTION_VARIABLE = 'PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS';

function restoreEnvironment(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

function assertInspectionLeaseAvailable(expectedRestoredValue: string): void {
  const release = acquireServiceWorkerNetworkInspection();
  expect(process.env[INSPECTION_VARIABLE]).toBe('1');
  release();
  expect(process.env[INSPECTION_VARIABLE]).toBe(expectedRestoredValue);
}

describe('Browser DID runtime', () => {
  it('should build and serve an immutable actor bootstrap before releasing its port', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'enbox-lab-browser-runtime-'));
    let origin: BrowserOrigin | undefined;
    let stopped = false;
    try {
      const didsBundle = didsBrowserBundle();
      expect(await Bun.file(didsBundle).exists()).toBe(true);
      const workerBundle = await buildServiceWorkerBundle(directory);
      expect(await Bun.file(workerBundle).exists()).toBe(true);
      expect(workerBundle.startsWith(directory)).toBe(true);

      const startedOrigin = startBrowserOrigin(didsBundle, workerBundle);
      origin = startedOrigin;
      const unconfigured = await fetch(startedOrigin.origin);
      expect(unconfigured.status).toBe(503);
      expect(await unconfigured.text()).toBe('DID gateway bootstrap is not configured.');

      const worker = await fetch(`${startedOrigin.origin}/did-service-worker.mjs`);
      expect(worker.status).toBe(200);
      expect(worker.headers.get('cache-control')).toBe('no-store');
      expect(worker.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
      expect(worker.headers.get('service-worker-allowed')).toBe('/');
      expect(worker.headers.get('x-content-type-options')).toBe('nosniff');
      expect((await worker.text()).length).toBeGreaterThan(1_000);

      const dids = await fetch(`${startedOrigin.origin}/dids.mjs`);
      expect(dids.status).toBe(200);
      expect(dids.headers.get('cache-control')).toBe('no-store');
      expect(dids.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
      await dids.body?.cancel();
      expect((await fetch(`${startedOrigin.origin}/unknown`)).status).toBe(404);

      for (const invalid of [
        'not-a-url',
        'ftp://127.0.0.1:45000/',
        'http://user@127.0.0.1:45000/',
        'http://127.0.0.1:45000',
        'http://127.0.0.1:45000/path',
        'http://127.0.0.1:45000/?query=1',
        'http://127.0.0.1:45000/#fragment',
      ]) {
        expect((): void => startedOrigin.configureGateway(invalid)).toThrow();
      }

      const gatewayUri = 'http://127.0.0.1:45000/';
      expect((): void => startedOrigin.configureGateway(gatewayUri)).not.toThrow();
      expect((): void => startedOrigin.configureGateway(gatewayUri)).not.toThrow();
      expect((): void => startedOrigin.configureGateway('http://127.0.0.1:45001/')).toThrow('immutable');

      const page = await fetch(startedOrigin.origin);
      expect(page.status).toBe(200);
      expect(page.headers.get('cache-control')).toBe('no-store');
      expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
      const html = await page.text();
      const script = /<script>([\s\S]+)<\/script>/u.exec(html)?.[1];
      if (script === undefined) {
        throw new Error('Browser origin did not emit its bootstrap script.');
      }
      const sandbox: Record<string, unknown> = {};
      runInNewContext(script, sandbox);
      const bootstrap = sandbox.enboxLabDidConfig as Record<string, unknown>;
      expect(bootstrap).toEqual({ actorOrigin: startedOrigin.origin, gatewayUri });
      expect(Object.isFrozen(bootstrap)).toBe(true);
      expect(Object.getOwnPropertyDescriptor(sandbox, 'enboxLabDidConfig')).toMatchObject({
        configurable : false,
        writable     : false,
      });

      await startedOrigin.stop();
      stopped = true;
      await expect(fetch(`${startedOrigin.origin}/after-stop`, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
    } finally {
      if (!stopped) {
        await origin?.stop();
      }
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('should restore the exclusive inspection lease when browser launch rejects', async () => {
    const previous = process.env[INSPECTION_VARIABLE];
    process.env[INSPECTION_VARIABLE] = 'previous-value';
    try {
      const dependencies: BrowserDriverLaunchDependencies = {
        launch: async (options): Promise<never> => {
          expect(options).toEqual({ executablePath: '/test/chromium', headless: true });
          expect(process.env[INSPECTION_VARIABLE]).toBe('1');
          throw new Error('launch rejected');
        },
      };
      await expect(launchBrowserDriver('/test/chromium', dependencies)).rejects.toThrow('launch rejected');
      expect(process.env[INSPECTION_VARIABLE]).toBe('previous-value');
      assertInspectionLeaseAvailable('previous-value');
    } finally {
      restoreEnvironment(INSPECTION_VARIABLE, previous);
    }
  });

  it('should close a launched browser and restore the lease when context creation rejects', async () => {
    const previous = process.env[INSPECTION_VARIABLE];
    process.env[INSPECTION_VARIABLE] = 'previous-value';
    let closeCalls = 0;
    try {
      const dependencies: BrowserDriverLaunchDependencies = {
        launch: async () => ({
          close      : async (): Promise<void> => { closeCalls += 1; },
          newContext : async (options): Promise<never> => {
            expect(options).toEqual({ serviceWorkers: 'allow' });
            expect(process.env[INSPECTION_VARIABLE]).toBe('1');
            throw new Error('context rejected');
          },
          version: (): string => 'test-browser',
        }),
      };
      await expect(launchBrowserDriver('/test/chromium', dependencies)).rejects.toThrow('context rejected');
      expect(closeCalls).toBe(1);
      expect(process.env[INSPECTION_VARIABLE]).toBe('previous-value');
      assertInspectionLeaseAvailable('previous-value');
    } finally {
      restoreEnvironment(INSPECTION_VARIABLE, previous);
    }
  });

  it('should reject a concurrent inspection lease and release idempotently', () => {
    const previous = process.env[INSPECTION_VARIABLE];
    const release = acquireServiceWorkerNetworkInspection();
    try {
      expect(process.env[INSPECTION_VARIABLE]).toBe('1');
      expect((): () => void => acquireServiceWorkerNetworkInspection()).toThrow('already leased');
    } finally {
      release();
    }
    expect(process.env[INSPECTION_VARIABLE]).toBe(previous);
    release();
    expect(process.env[INSPECTION_VARIABLE]).toBe(previous);
  });
});
