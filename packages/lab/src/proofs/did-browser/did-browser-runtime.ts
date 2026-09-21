import type { Browser } from 'playwright';
import type { Page } from 'playwright';
import type { Request as PlaywrightRequest } from 'playwright';

import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { chromium } from 'playwright';

export type BrowserDidObservation = {
  didUri: string;
  published: boolean;
  resolvedDid: string;
  resolvedDwnEndpoint: string;
  secureContext: boolean;
};

export type ForeignOriginObservation = {
  putError: string;
  putRejected: boolean;
  subresourceRejected: boolean;
};

export type ServiceWorkerProbeObservation = {
  actorSubstitutionRejected: boolean;
  bootstrapLocked: boolean;
  browserRequests: BrowserRequestObservation[];
  malformedCommandRejected: boolean;
  oversizedCommandRejected: boolean;
  scriptUrl: string;
  unconfiguredError: string;
};

export type ServiceWorkerResolutionObservation = {
  bootstrapLocked: boolean;
  browserRequests: BrowserRequestObservation[];
  configured: boolean;
  reconfigurationRejected: boolean;
  resolutionError: string;
  resolvedDid: string;
  scriptUrl: string;
};

export type BrowserRequestObservation = {
  method: string;
  serviceWorkerOwned: boolean;
  serviceWorkerUrl: string;
  url: string;
};

export type BrowserOrigin = {
  configureGateway(gatewayUri: string): void;
  origin: string;
  stop(): Promise<void>;
};

export type BrowserDriver = {
  allowedReadStatus(didUri: string): Promise<number>;
  attemptForeignServiceWorker(origin: string, didUri: string): Promise<ServiceWorkerResolutionObservation>;
  attemptForeignRequests(origin: string, didUri: string): Promise<ForeignOriginObservation>;
  close(): Promise<void>;
  probeServiceWorker(origin: string, didUri: string): Promise<ServiceWorkerProbeObservation>;
  probeSiblingServiceWorker(origin: string, didUri: string): Promise<ServiceWorkerProbeObservation>;
  publishAndResolve(origin: string, advertisedDwnEndpoint: string): Promise<BrowserDidObservation>;
  resolveFromServiceWorker(origin: string, didUri: string): Promise<ServiceWorkerResolutionObservation>;
  version(): string;
};

export type BrowserDriverLaunchDependencies = {
  launch(options: { executablePath: string; headless: true }): Promise<Pick<Browser, 'close' | 'newContext' | 'version'>>;
};

const SERVICE_WORKER_NETWORK_INSPECTION_VARIABLE = 'PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS';
let serviceWorkerNetworkInspectionLeased = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Holds Playwright's process-global service-worker network instrumentation for one browser driver. */
export function acquireServiceWorkerNetworkInspection(): () => void {
  if (serviceWorkerNetworkInspectionLeased) {
    throw new Error('Browser DID service-worker network inspection is already leased by another driver.');
  }
  serviceWorkerNetworkInspectionLeased = true;
  const previous = process.env[SERVICE_WORKER_NETWORK_INSPECTION_VARIABLE];
  process.env[SERVICE_WORKER_NETWORK_INSPECTION_VARIABLE] = '1';
  let released = false;
  return (): void => {
    if (released) {
      return;
    }
    released = true;
    if (previous === undefined) {
      delete process.env[SERVICE_WORKER_NETWORK_INSPECTION_VARIABLE];
    } else {
      process.env[SERVICE_WORKER_NETWORK_INSPECTION_VARIABLE] = previous;
    }
    serviceWorkerNetworkInspectionLeased = false;
  };
}

export function didsBrowserBundle(): string {
  const esmEntry = fileURLToPath(import.meta.resolve('@enbox/dids'));
  return resolve(dirname(esmEntry), '../browser.mjs');
}

function serviceWorkerEntry(): string {
  const currentPath = fileURLToPath(import.meta.url);
  const extension = currentPath.endsWith('.ts') ? 'ts' : 'js';
  return join(dirname(currentPath), 'fixture', `did-service-worker.${extension}`);
}

export async function buildServiceWorkerBundle(directory: string): Promise<string> {
  const outputDirectory = join(directory, 'browser');
  await mkdir(outputDirectory, { recursive: true });
  const result = await Bun.build({
    entrypoints : [serviceWorkerEntry()],
    format      : 'esm',
    minify      : true,
    outdir      : outputDirectory,
    sourcemap   : 'none',
    splitting   : false,
    target      : 'browser',
  });
  if (!result.success) {
    throw new Error(`Browser DID service-worker build failed: ${result.logs.map(String).join('; ')}`);
  }
  const bundle = result.outputs.find((output): boolean => basename(output.path) === 'did-service-worker.js');
  if (bundle === undefined) {
    throw new Error(`Browser DID service-worker build omitted its entry: ${JSON.stringify(result.outputs.map((output) => basename(output.path)))}`);
  }
  return bundle.path;
}

export function startBrowserOrigin(bundlePath: string, workerBundlePath: string): BrowserOrigin {
  let gatewayUri: string | undefined;
  const server = Bun.serve({
    fetch(request): Response {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/dids.mjs') {
        return new Response(Bun.file(bundlePath), {
          headers: {
            'Cache-Control' : 'no-store',
            'Content-Type'  : 'text/javascript; charset=utf-8',
          },
        });
      }
      if (pathname === '/did-service-worker.mjs') {
        return new Response(Bun.file(workerBundlePath), {
          headers: {
            'Cache-Control'          : 'no-store',
            'Content-Type'           : 'text/javascript; charset=utf-8',
            'Service-Worker-Allowed' : '/',
            'X-Content-Type-Options' : 'nosniff',
          },
        });
      }
      if (pathname === '/') {
        if (gatewayUri === undefined) {
          return new Response('DID gateway bootstrap is not configured.', { status: 503 });
        }
        const actorOrigin = new URL(request.url).origin;
        const bootstrap = JSON.stringify({ actorOrigin, gatewayUri });
        const configScript = `Object.defineProperty(globalThis, 'enboxLabDidConfig', ` +
          `{ configurable: false, value: Object.freeze(${bootstrap}), writable: false });`;
        return new Response(`<!doctype html>
<meta charset="utf-8">
<title>Enbox DID browser proof</title>
<script>${configScript}</script>`, {
          headers: {
            'Cache-Control' : 'no-store',
            'Content-Type'  : 'text/html; charset=utf-8',
          },
        });
      }
      return new Response('not found', { status: 404 });
    },
    hostname : '127.0.0.1',
    port     : 0,
  });
  return {
    configureGateway: (value): void => {
      const candidate = new URL(value);
      if ((candidate.protocol !== 'http:' && candidate.protocol !== 'https:') || candidate.username !== '' ||
        candidate.password !== '' || candidate.href !== value || candidate.search !== '' || candidate.hash !== '' ||
        !candidate.pathname.endsWith('/')) {
        throw new TypeError('Browser DID gateway bootstrap must be a canonical HTTP(S) base URI.');
      }
      if (gatewayUri !== undefined && gatewayUri !== candidate.href) {
        throw new Error('Browser DID gateway bootstrap is immutable once configured.');
      }
      gatewayUri = candidate.href;
    },
    origin : `http://127.0.0.1:${server.port}`,
    stop   : async (): Promise<void> => { await server.stop(true); },
  };
}

async function publishAndResolve(page: Page, advertisedDwnEndpoint: string): Promise<BrowserDidObservation> {
  return page.evaluate(async ({ advertisedDwnEndpoint: endpoint }) => {
    const container = globalThis as typeof globalThis & { enboxLabDidConfig?: unknown };
    const config = container.enboxLabDidConfig;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'enboxLabDidConfig');
    if (typeof config !== 'object' || config === null || Array.isArray(config) || !Object.isFrozen(config) ||
      descriptor?.configurable !== false || descriptor.writable !== false) {
      throw new Error('Browser DID bootstrap is missing or mutable.');
    }
    const values = config as Record<string, unknown>;
    if (Object.keys(values).sort().join(',') !== 'actorOrigin,gatewayUri' || values.actorOrigin !== location.origin ||
      typeof values.gatewayUri !== 'string') {
      throw new Error('Browser DID bootstrap does not match this actor.');
    }
    const gateway = values.gatewayUri;
    const didsModulePath = '/dids.mjs';
    const { DidDht } = await import(didsModulePath);
    const did = await DidDht.create({
      options: {
        publish  : false,
        services : [{ id: 'dwn', serviceEndpoint: endpoint, type: 'DecentralizedWebNode' }],
      },
    });
    const publication = await DidDht.publish({
      allowPrivateGatewayUri : true,
      did,
      gatewayUri             : gateway,
    });
    const resolution = await DidDht.resolve(did.uri, {
      allowPrivateGatewayUri : true,
      gatewayUri             : gateway,
    });
    const service = resolution.didDocument?.service?.find((entry: { type?: unknown }): boolean => entry.type === 'DecentralizedWebNode');
    const serviceEndpoint = Array.isArray(service?.serviceEndpoint) ? service.serviceEndpoint[0] : service?.serviceEndpoint;
    return {
      didUri              : did.uri,
      published           : publication.didDocumentMetadata.published === true,
      resolvedDid         : resolution.didDocument?.id ?? '',
      resolvedDwnEndpoint : typeof serviceEndpoint === 'string' ? serviceEndpoint : '',
      secureContext       : window.isSecureContext,
    };
  }, { advertisedDwnEndpoint });
}

async function attemptForeignRequests(page: Page, didUri: string): Promise<ForeignOriginObservation> {
  return page.evaluate(async ({ didUri: uri }) => {
    const config = (globalThis as typeof globalThis & {
      enboxLabDidConfig?: { actorOrigin?: unknown; gatewayUri?: unknown };
    }).enboxLabDidConfig;
    if (config?.actorOrigin !== location.origin || typeof config.gatewayUri !== 'string') {
      throw new Error('Foreign browser DID bootstrap does not match this actor.');
    }
    const gateway = config.gatewayUri;
    const identifier = uri.split(':').at(-1) ?? '';
    let putError = '';
    let putRejected = false;
    try {
      await fetch(new URL(identifier, gateway), {
        body    : new Uint8Array(80),
        headers : { 'Content-Type': 'application/octet-stream' },
        method  : 'PUT',
        mode    : 'cors',
      });
    } catch (error: unknown) {
      putError = String(error);
      putRejected = true;
    }
    const subresourceRejected = await new Promise<boolean>((resolve): void => {
      const image = new Image();
      image.addEventListener('error', (): void => { resolve(true); }, { once: true });
      image.addEventListener('load', (): void => { resolve(false); }, { once: true });
      image.src = new URL(`${identifier}?originless=1`, gateway).toString();
    });
    return { putError, putRejected, subresourceRejected };
  }, { didUri });
}

async function allowedReadStatus(page: Page, didUri: string): Promise<number> {
  return page.evaluate(async ({ didUri: uri }) => {
    const config = (globalThis as typeof globalThis & {
      enboxLabDidConfig?: { actorOrigin?: unknown; gatewayUri?: unknown };
    }).enboxLabDidConfig;
    if (config?.actorOrigin !== location.origin || typeof config.gatewayUri !== 'string') {
      throw new Error('Browser DID bootstrap does not match this actor.');
    }
    const identifier = uri.split(':').at(-1) ?? '';
    const response = await fetch(new URL(identifier, config.gatewayUri), { mode: 'cors' });
    await response.body?.cancel();
    return response.status;
  }, { didUri });
}

type WorkerPageObservation = {
  actorSubstitutionRejected: boolean;
  bootstrapLocked: boolean;
  configured: boolean;
  malformedCommandRejected: boolean;
  oversizedCommandRejected: boolean;
  reconfigurationRejected: boolean;
  resolutionError: string;
  resolvedDid: string;
  scriptUrl: string;
  unconfiguredError: string;
};

async function prepareServiceWorker(page: Page): Promise<void> {
  await page.evaluate(async (): Promise<void> => {
    const timeoutMs = 10_000;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject): void => {
      timeoutId = setTimeout((): void => { reject(new Error('Service-worker preparation timed out.')); }, timeoutMs);
    });
    try {
      const registration = await Promise.race([
        navigator.serviceWorker.register('/did-service-worker.mjs', { scope: '/', type: 'module' }),
        timeout,
      ]);
      const ready = await Promise.race([navigator.serviceWorker.ready, timeout]);
      if ((ready.active ?? registration.active) === null) {
        throw new Error('Service-worker preparation completed without an active worker.');
      }
    } finally {
      clearTimeout(timeoutId);
    }
  });
}

async function serviceWorkerResolution(
  page: Page,
  didUri: string,
  mode: 'probe' | 'resolve',
): Promise<WorkerPageObservation> {
  return page.evaluate(async ({ didUri: requestedDid, mode: selectedMode }) => {
    type RpcResponse =
      | { error: string; id: string; ok: false }
      | { id: string; ok: true; result: Record<string, unknown> };

    const timeoutMs = 10_000;
    const withTimeout = async <T>(operation: Promise<T>, label: string): Promise<T> => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject): void => {
        timeoutId = setTimeout((): void => { reject(new Error(`${label} timed out.`)); }, timeoutMs);
      });
      try {
        return await Promise.race([operation, timeout]);
      } finally {
        clearTimeout(timeoutId);
      }
    };
    const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
      const actual = Object.keys(value).sort();
      return actual.length === keys.length && actual.every((key, index): boolean => key === keys[index]);
    };
    const isRecord = (value: unknown): value is Record<string, unknown> => {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    };

    if (!('serviceWorker' in navigator) || !window.isSecureContext) {
      throw new Error('Service workers are unavailable outside a secure browser context.');
    }
    const container = globalThis as typeof globalThis & { enboxLabDidConfig?: unknown };
    const config = container.enboxLabDidConfig;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'enboxLabDidConfig');
    const bootstrapLocked = isRecord(config) && Object.isFrozen(config) &&
      descriptor?.configurable === false && descriptor.writable === false &&
      exactKeys(config, ['actorOrigin', 'gatewayUri']) && config.actorOrigin === location.origin &&
      typeof config.gatewayUri === 'string';
    if (!bootstrapLocked || !isRecord(config) || typeof config.gatewayUri !== 'string') {
      throw new Error('Service-worker DID bootstrap is missing, mutable, or belongs to another actor.');
    }
    const gateway = config.gatewayUri;
    const registration = await withTimeout(
      navigator.serviceWorker.register('/did-service-worker.mjs', { scope: '/', type: 'module' }),
      'Service-worker registration',
    );
    const ready = await withTimeout(navigator.serviceWorker.ready, 'Service-worker readiness');
    const worker = ready.active ?? registration.active;
    if (worker === null) {
      throw new Error('Service-worker registration became ready without an active worker.');
    }

    const rpc = async (command: Record<string, unknown>): Promise<RpcResponse> => {
      const id = crypto.randomUUID();
      const request = { ...command, id };
      const response = await withTimeout(new Promise<unknown>((resolveResponse, reject): void => {
        const channel = new MessageChannel();
        channel.port1.addEventListener('message', (event): void => {
          channel.port1.close();
          resolveResponse(event.data);
        }, { once: true });
        channel.port1.addEventListener('messageerror', (): void => {
          channel.port1.close();
          reject(new Error('Service-worker response could not be decoded.'));
        }, { once: true });
        channel.port1.start();
        worker.postMessage(request, [channel.port2]);
      }), 'Service-worker command');
      if (!isRecord(response) || response.id !== id || typeof response.ok !== 'boolean') {
        throw new Error('Service-worker response envelope is malformed.');
      }
      if (response.ok) {
        if (!exactKeys(response, ['id', 'ok', 'result']) || !isRecord(response.result)) {
          throw new Error('Service-worker success response is malformed.');
        }
        return response as RpcResponse;
      }
      if (!exactKeys(response, ['error', 'id', 'ok']) || typeof response.error !== 'string') {
        throw new Error('Service-worker failure response is malformed.');
      }
      return response as RpcResponse;
    };
    const errorCode = (response: RpcResponse): string => response.ok ? '' : response.error;

    if (selectedMode === 'probe') {
      const malformed = await rpc({ didUri: requestedDid, extra: true, kind: 'resolve' });
      const oversized = await rpc({
        actorOrigin : location.origin,
        gatewayUri  : `http://127.0.0.1/${'x'.repeat(2_049)}/`,
        kind        : 'configure',
      });
      const substituted = await rpc({
        actorOrigin : 'https://attacker.invalid',
        gatewayUri  : gateway,
        kind        : 'configure',
      });
      const unconfigured = await rpc({ didUri: requestedDid, kind: 'resolve' });
      return {
        actorSubstitutionRejected : errorCode(substituted) === 'actor-mismatch',
        bootstrapLocked,
        configured                : false,
        malformedCommandRejected  : errorCode(malformed) === 'invalid-request',
        oversizedCommandRejected  : errorCode(oversized) === 'invalid-request',
        reconfigurationRejected   : false,
        resolutionError           : '',
        resolvedDid               : '',
        scriptUrl                 : worker.scriptURL,
        unconfiguredError         : errorCode(unconfigured),
      };
    }

    const configured = await rpc({ actorOrigin: location.origin, gatewayUri: gateway, kind: 'configure' });
    const configurationAccepted = configured.ok && configured.result.configured === true &&
      exactKeys(configured.result, ['configured']);
    const resolution = await rpc({ didUri: requestedDid, kind: 'resolve' });
    const resolvedDid = resolution.ok && typeof resolution.result.resolvedDid === 'string' &&
      exactKeys(resolution.result, ['resolvedDid']) ? resolution.result.resolvedDid : '';
    const replacementGateway = new URL('replacement/', gateway).href;
    const replacement = await rpc({
      actorOrigin : location.origin,
      gatewayUri  : replacementGateway,
      kind        : 'configure',
    });
    return {
      actorSubstitutionRejected : false,
      bootstrapLocked,
      configured                : configurationAccepted,
      malformedCommandRejected  : false,
      oversizedCommandRejected  : false,
      reconfigurationRejected   : errorCode(replacement) === 'configuration-conflict',
      resolutionError           : errorCode(resolution),
      resolvedDid,
      scriptUrl                 : worker.scriptURL,
      unconfiguredError         : '',
    };
  }, { didUri, mode });
}

async function captureServiceWorkerRequests<T>(page: Page, operation: () => Promise<T>): Promise<{
  browserRequests: BrowserRequestObservation[];
  result: T;
}> {
  const browserRequests: BrowserRequestObservation[] = [];
  const context = page.context();
  const observe = (request: PlaywrightRequest): void => {
    const serviceWorker = request.serviceWorker();
    browserRequests.push({
      method             : request.method(),
      serviceWorkerOwned : serviceWorker !== null,
      serviceWorkerUrl   : serviceWorker?.url() ?? '',
      url                : request.url(),
    });
  };
  context.on('request', observe);
  try {
    return { browserRequests, result: await operation() };
  } finally {
    context.off('request', observe);
  }
}

const defaultBrowserDriverLaunchDependencies: BrowserDriverLaunchDependencies = {
  launch: (options): Promise<Browser> => chromium.launch(options),
};

export async function launchBrowserDriver(
  executablePath: string,
  dependencies: BrowserDriverLaunchDependencies = defaultBrowserDriverLaunchDependencies,
): Promise<BrowserDriver> {
  const releaseInspection = acquireServiceWorkerNetworkInspection();
  let browser: Awaited<ReturnType<BrowserDriverLaunchDependencies['launch']>>;
  try {
    browser = await dependencies.launch({ executablePath, headless: true });
  } catch (error: unknown) {
    releaseInspection();
    throw error;
  }
  let context: Awaited<ReturnType<typeof browser.newContext>>;
  try {
    context = await browser.newContext({ serviceWorkers: 'allow' });
  } catch (error: unknown) {
    await browser.close().catch((): void => {});
    releaseInspection();
    throw error;
  }
  let allowedPage: Page | undefined;
  const serviceWorkerPages = new Set<Page>();
  return {
    allowedReadStatus: async (didUri): Promise<number> => {
      if (allowedPage === undefined) {
        throw new Error('Browser DID driver: publishAndResolve() must run before allowedReadStatus().');
      }
      return allowedReadStatus(allowedPage, didUri);
    },
    attemptForeignRequests: async (origin, didUri): Promise<ForeignOriginObservation> => {
      const page = await context.newPage();
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      return attemptForeignRequests(page, didUri);
    },
    attemptForeignServiceWorker: async (origin, didUri): Promise<ServiceWorkerResolutionObservation> => {
      const page = await context.newPage();
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      serviceWorkerPages.add(page);
      await prepareServiceWorker(page);
      const captured = await captureServiceWorkerRequests(
        page,
        async (): Promise<WorkerPageObservation> => serviceWorkerResolution(page, didUri, 'resolve'),
      );
      const observation = captured.result;
      return {
        bootstrapLocked         : observation.bootstrapLocked,
        browserRequests         : captured.browserRequests,
        configured              : observation.configured,
        reconfigurationRejected : observation.reconfigurationRejected,
        resolutionError         : observation.resolutionError,
        resolvedDid             : observation.resolvedDid,
        scriptUrl               : observation.scriptUrl,
      };
    },
    close: async (): Promise<void> => {
      const cleanupErrors: string[] = [];
      try {
        for (const page of serviceWorkerPages) {
          if (page.isClosed()) {
            continue;
          }
          try {
            await page.evaluate(async (): Promise<void> => {
              const registrations = await navigator.serviceWorker.getRegistrations();
              let timeoutId: ReturnType<typeof setTimeout> | undefined;
              const timeout = new Promise<never>((_resolve, reject): void => {
                timeoutId = setTimeout((): void => { reject(new Error('Service-worker cleanup timed out.')); }, 5_000);
              });
              try {
                const unregistered = await Promise.race([
                  Promise.all(registrations.map((registration) => registration.unregister())),
                  timeout,
                ]);
                if (unregistered.some((removed): boolean => !removed)) {
                  throw new Error('Service-worker cleanup did not unregister every owned registration.');
                }
              } finally {
                clearTimeout(timeoutId);
              }
            });
          } catch (error: unknown) {
            cleanupErrors.push(errorMessage(error));
          }
        }
      } finally {
        try {
          await context.close();
        } catch (error: unknown) {
          cleanupErrors.push(errorMessage(error));
        }
        try {
          await browser.close();
        } catch (error: unknown) {
          cleanupErrors.push(errorMessage(error));
        }
        releaseInspection();
      }
      if (cleanupErrors.length > 0) {
        throw new Error(`Browser DID driver cleanup failed: ${cleanupErrors.join('; ')}`);
      }
    },
    probeServiceWorker: async (origin, didUri): Promise<ServiceWorkerProbeObservation> => {
      if (allowedPage === undefined || new URL(allowedPage.url()).origin !== origin) {
        throw new Error('Browser DID driver: publishAndResolve() must run before probeServiceWorker().');
      }
      serviceWorkerPages.add(allowedPage);
      await prepareServiceWorker(allowedPage);
      const captured = await captureServiceWorkerRequests(
        allowedPage,
        async (): Promise<WorkerPageObservation> => serviceWorkerResolution(allowedPage!, didUri, 'probe'),
      );
      const observation = captured.result;
      return {
        actorSubstitutionRejected : observation.actorSubstitutionRejected,
        bootstrapLocked           : observation.bootstrapLocked,
        browserRequests           : captured.browserRequests,
        malformedCommandRejected  : observation.malformedCommandRejected,
        oversizedCommandRejected  : observation.oversizedCommandRejected,
        scriptUrl                 : observation.scriptUrl,
        unconfiguredError         : observation.unconfiguredError,
      };
    },
    probeSiblingServiceWorker: async (origin, didUri): Promise<ServiceWorkerProbeObservation> => {
      if (allowedPage === undefined || new URL(allowedPage.url()).origin !== origin) {
        throw new Error('Browser DID driver: publishAndResolve() must run before probeSiblingServiceWorker().');
      }
      const page = await allowedPage.context().newPage();
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      serviceWorkerPages.add(page);
      await prepareServiceWorker(page);
      const captured = await captureServiceWorkerRequests(
        page,
        async (): Promise<WorkerPageObservation> => serviceWorkerResolution(page, didUri, 'probe'),
      );
      const observation = captured.result;
      return {
        actorSubstitutionRejected : observation.actorSubstitutionRejected,
        bootstrapLocked           : observation.bootstrapLocked,
        browserRequests           : captured.browserRequests,
        malformedCommandRejected  : observation.malformedCommandRejected,
        oversizedCommandRejected  : observation.oversizedCommandRejected,
        scriptUrl                 : observation.scriptUrl,
        unconfiguredError         : observation.unconfiguredError,
      };
    },
    publishAndResolve: async (origin, advertisedDwnEndpoint): Promise<BrowserDidObservation> => {
      allowedPage = await context.newPage();
      await allowedPage.goto(origin, { waitUntil: 'domcontentloaded' });
      return publishAndResolve(allowedPage, advertisedDwnEndpoint);
    },
    resolveFromServiceWorker: async (origin, didUri): Promise<ServiceWorkerResolutionObservation> => {
      if (allowedPage === undefined || new URL(allowedPage.url()).origin !== origin) {
        throw new Error('Browser DID driver: publishAndResolve() must run before resolveFromServiceWorker().');
      }
      serviceWorkerPages.add(allowedPage);
      await prepareServiceWorker(allowedPage);
      const captured = await captureServiceWorkerRequests(
        allowedPage,
        async (): Promise<WorkerPageObservation> => serviceWorkerResolution(allowedPage!, didUri, 'resolve'),
      );
      const observation = captured.result;
      return {
        bootstrapLocked         : observation.bootstrapLocked,
        browserRequests         : captured.browserRequests,
        configured              : observation.configured,
        reconfigurationRejected : observation.reconfigurationRejected,
        resolutionError         : observation.resolutionError,
        resolvedDid             : observation.resolvedDid,
        scriptUrl               : observation.scriptUrl,
      };
    },
    version: (): string => browser.version(),
  };
}
