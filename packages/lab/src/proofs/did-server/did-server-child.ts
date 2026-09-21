import type { DwnServerConfig } from '@enbox/dwn-server';
import type { DidResolutionOptions, DidResolutionResult } from '@enbox/dids';

import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';

import { dirname, join, resolve } from 'node:path';

import { defaultDwnServerConfig, DwnServer } from '@enbox/dwn-server';
import { DidDht, DidJwk, DidKey, UniversalResolver } from '@enbox/dids';

import {
  DID_SERVER_CHILD_MAX_LINE_BYTES,
  DID_SERVER_PACKAGE_NAME,
  DID_SERVER_PACKAGE_VERSION,
  parseDidServerChildStartCommand,
  parseDidServerChildStopCommand,
} from './did-server-child-protocol.js';

const LOOPBACK_HOSTNAME = '127.0.0.1';
const MAX_READINESS_BYTES = 512;

type InstalledPackageManifest = Readonly<{
  name?: unknown;
  version?: unknown;
}>;

function fixedError(message: string): Error {
  return new Error(`DidServerChild: ${message}`);
}

/** Creates a did:dht method adapter whose caller cannot override the private testnet. */
export function createPrivateDidDhtMethod(resolverBaseUri: string): typeof DidDht {
  return class PrivateDidDht extends DidDht {
    public static override async resolve(
      didUri: string,
      options: DidResolutionOptions = {},
    ): Promise<DidResolutionResult> {
      return DidDht.resolve(didUri, {
        ...options,
        gatewayUri             : resolverBaseUri,
        allowPrivateGatewayUri : true,
      });
    }
  };
}

/** Builds the resolver surface used by the proof server. did:web is deliberately absent. */
export function createPrivateDidResolver(resolverBaseUri: string): UniversalResolver {
  return new UniversalResolver({
    didResolvers: [createPrivateDidDhtMethod(resolverBaseUri), DidJwk, DidKey],
  });
}

/** Builds an isolated, loopback-only server configuration from the released defaults. */
export function createPrivateDidServerConfig(
  storageDirectory: string,
  packageJsonPath: string,
  publicOrigin: string,
): DwnServerConfig {
  const dwnSqliteUrl = `sqlite://${join(storageDirectory, 'dwn.sqlite')}`;
  const serverSqliteUrl = `sqlite://${join(storageDirectory, 'server.sqlite')}`;
  const config: DwnServerConfig = {
    ...defaultDwnServerConfig,
    adminToken                       : '',
    baseUrl                          : publicOrigin,
    dataStore                        : dwnSqliteUrl,
    deliveryEnabled                  : false,
    eventBusPluginPath               : '',
    forwardingEnabled                : false,
    hostname                         : LOOPBACK_HOSTNAME,
    localNodeAllowedOrigins          : [],
    localNodeProfileEnabled          : false,
    logLevel                         : 'SILENT',
    messageStore                     : dwnSqliteUrl,
    packageJsonPath,
    port                             : 0,
    providerAuthEnabled              : false,
    rateLimitBurst                   : 0,
    rateLimitRequestsPerSecond       : 0,
    rateLimitTenantBurst             : 0,
    rateLimitTenantRequestsPerSecond : 0,
    registrationProofOfWorkEnabled   : false,
    resumableTaskStore               : dwnSqliteUrl,
    serverName                       : DID_SERVER_PACKAGE_NAME,
    ttlCacheUrl                      : serverSqliteUrl,
    webSocketSupport                 : false,
  };
  // The released declaration says this field is required, while its runtime contract explicitly
  // uses absence to disable tenant registration and choose ttlCacheUrl for server migrations.
  Reflect.deleteProperty(config, 'registrationStoreUrl');
  return config;
}

async function resolveReleasedPackageManifest(): Promise<string> {
  const serverEntryPath = fileURLToPath(import.meta.resolve(DID_SERVER_PACKAGE_NAME));
  const packageJsonPath = resolve(dirname(serverEntryPath), '../../../package.json');
  const packageFile = Bun.file(packageJsonPath);
  if (!await packageFile.exists()) {
    throw fixedError('released server manifest is missing');
  }
  const manifest = await packageFile.json() as InstalledPackageManifest;
  if (manifest.name !== DID_SERVER_PACKAGE_NAME || manifest.version !== DID_SERVER_PACKAGE_VERSION) {
    throw fixedError('released server version does not match the proof contract');
  }
  return packageJsonPath;
}

async function assertStorageDirectory(storageDirectory: string): Promise<void> {
  let storageStat;
  try {
    storageStat = await stat(storageDirectory);
  } catch {
    throw fixedError('storage directory is unavailable');
  }
  if (!storageStat.isDirectory()) {
    throw fixedError('storage path is not a directory');
  }
}

async function* readBoundedInputLines(): AsyncGenerator<string> {
  const bytes: number[] = [];
  const reader = Bun.stdin.stream().getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      for (const byte of result.value) {
        if (byte === 0x0a) {
          if (bytes.at(-1) === 0x0d) {
            bytes.pop();
          }
          yield new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
          bytes.length = 0;
        } else {
          if (bytes.length >= DID_SERVER_CHILD_MAX_LINE_BYTES) {
            throw fixedError('input line exceeds the limit');
          }
          bytes.push(byte);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (bytes.length > 0) {
    yield new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  }
}

function writeReadiness(origin: string): void {
  const message = JSON.stringify({
    origin,
    packageName    : DID_SERVER_PACKAGE_NAME,
    packageVersion : DID_SERVER_PACKAGE_VERSION,
    type           : 'ready',
  }) + '\n';
  if (Buffer.byteLength(message, 'utf8') > MAX_READINESS_BYTES) {
    throw fixedError('readiness message exceeds the limit');
  }
  process.stdout.write(message);
}

async function runChild(): Promise<void> {
  // The released SQL startup path writes migration details with console.log.
  // Keep stdout machine-readable and limited to the one readiness record below.
  console.log = (): void => {};
  console.info = (): void => {};
  console.warn = (): void => {};
  console.error = (): void => {};

  const lines = readBoundedInputLines();
  const first = await lines.next();
  if (first.done) {
    throw fixedError('startup command is missing');
  }
  const command = parseDidServerChildStartCommand(first.value);
  await assertStorageDirectory(command.storageDirectory);
  const packageJsonPath = await resolveReleasedPackageManifest();
  const config = createPrivateDidServerConfig(command.storageDirectory, packageJsonPath, command.publicOrigin);
  const server = new DwnServer({
    config,
    didResolver: createPrivateDidResolver(command.resolverBaseUri),
  });

  let started = false;
  try {
    await server.start();
    started = true;

    const hostname = server.httpServer.hostname;
    const port = Number(server.httpServer.port);
    if (hostname !== LOOPBACK_HOSTNAME || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw fixedError('released server did not bind the required loopback endpoint');
    }
    const origin = `http://${LOOPBACK_HOSTNAME}:${port}`;
    writeReadiness(origin);

    const next = await lines.next();
    if (!next.done) {
      parseDidServerChildStopCommand(next.value);
    }
  } finally {
    if (started) {
      await server.stop();
    }
  }
}

if (import.meta.main) {
  runChild().catch((): void => {
    process.stderr.write('Enbox Lab DID server child failed\n');
    process.exit(1);
  });
}
