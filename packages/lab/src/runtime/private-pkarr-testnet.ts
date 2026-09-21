import { dockerResourceIsAbsent, imageMatchesHostArchitecture, isDigestPinnedImage } from '../proofs/docker-proof.js';

export type DockerCommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

export type PrivatePkarrTestnetDependencies = {
  displayName?: string;
  labId?: string;
  ownerId?: string;
  randomUuid?: () => string;
  runId?: string;
  runCommand?: (command: string[]) => Promise<DockerCommandResult>;
  waitForRelay?: (endpoint: string) => Promise<void>;
};

export type PrivatePkarrRelay = {
  containerId: string;
  endpoint: string;
};

export type PrivatePkarrTestnetEvidence = {
  attachedNetworks: string[];
  command: string[];
  containerImage: string;
  dockerVersion: string;
  displayName: string;
  egressMasquerading: boolean;
  imageArchitecture: string;
  imageDigest: string;
  imageDigestRecorded: boolean;
  imageId: string;
  imageOs: string;
  labId: string;
  nativeImage: boolean;
  ownedNetwork: boolean;
  ownerId: string;
  runId: string;
  verified: boolean;
};

export type PrivatePkarrTestnetCleanup = {
  containerName: string;
  errors: string[];
  networkName: string;
  ownerId: string;
  passed: boolean;
  runId: string;
};

type RelayConfigInspection = {
  Cmd?: string[];
  Image?: string;
  Labels?: Record<string, string>;
};

type RelayInspection = {
  Config?: RelayConfigInspection;
  NetworkSettings?: {
    Networks?: Record<string, unknown>;
  };
};

type ImageInspection = {
  Architecture?: string;
  Id?: string;
  Os?: string;
  RepoDigests?: string[];
};

type NetworkInspection = {
  Containers?: Record<string, unknown>;
  Labels?: Record<string, string>;
  Options?: Record<string, string>;
};

const ACTOR_LABEL = 'org.enbox.lab.actor-id';
const DISPLAY_LABEL = 'org.enbox.lab.display-name';
const LAB_LABEL = 'org.enbox.lab.lab-id';
const OWNER_LABEL = 'org.enbox.lab.ownership-id';
const PROOF_LABEL = 'org.enbox.lab.proof-run-id';
const DEFAULT_DISPLAY_NAME = 'DID Persistence Proof';
const RELAY_PORT = 15411;
const RELAY_READY_ATTEMPTS = 60;
const RELAY_READY_DELAY_MS = 250;
const TESTNET_COMMAND = ['pkarr-relay', '--testnet'];

export const PKARR_RELAY_IMAGE = 'synonymsoft/pkarr-relay@sha256:779353eb69f20be93f5c3d740a633045ef80f8a480467085da19cc8ea57251a4';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedDisplayName(value: string): string {
  const hasControlCharacter = [...value].some((character): boolean => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (value.length === 0 || new TextEncoder().encode(value).byteLength > 128 || hasControlCharacter) {
    throw new TypeError('PrivatePkarrTestnet: displayName must be a non-empty string of at most 128 bytes without control characters');
  }
  return value;
}

function randomIdentifier(value: string, field: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new TypeError(`PrivatePkarrTestnet: ${field} must be a canonical random UUID`);
  }
  return value.toLowerCase();
}

async function defaultRunCommand(command: string[]): Promise<DockerCommandResult> {
  try {
    const child = Bun.spawn(command, {
      stderr : 'pipe',
      stdout : 'pipe',
    });
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    return { exitCode, stderr: stderr.trim(), stdout: stdout.trim() };
  } catch (error: unknown) {
    return { exitCode: -1, stderr: errorMessage(error), stdout: '' };
  }
}

async function expectCommand(
  runner: NonNullable<PrivatePkarrTestnetDependencies['runCommand']>,
  command: string[],
): Promise<DockerCommandResult> {
  const result = await runner(command);
  if (result.exitCode !== 0) {
    throw new Error(`${command.slice(0, 3).join(' ')} failed (${result.exitCode}): ${result.stderr || result.stdout || 'no output'}`);
  }
  return result;
}

function lastJsonLine<T>(output: string): T {
  const line = output.split('\n').map((entry): string => entry.trim()).filter(Boolean).at(-1);
  if (line === undefined) {
    throw new Error('command returned no JSON output');
  }
  return JSON.parse(line) as T;
}

function token(value: string): string {
  return value.replaceAll('-', '').slice(0, 12).toLowerCase();
}

function resourceLabelArguments(runId: string, labId: string, ownerId: string, displayName: string, actorId?: string): string[] {
  return [
    ...(actorId === undefined ? [] : ['--label', `${ACTOR_LABEL}=${actorId}`]),
    '--label', `${DISPLAY_LABEL}=${displayName}`,
    '--label', `${LAB_LABEL}=${labId}`,
    '--label', `${OWNER_LABEL}=${ownerId}`,
    '--label', `${PROOF_LABEL}=${runId}`,
  ];
}

function mappedRelayPort(output: string): number {
  const match = output.match(/^127\.0\.0\.1:(\d+)\s*$/u);
  const port = Number(match?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Unable to parse the relay's loopback port from '${output.trim()}'.`);
  }
  return port;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve): void => {
    setTimeout(resolve, milliseconds);
  });
}

async function defaultWaitForRelay(endpoint: string): Promise<void> {
  let lastError = 'relay did not accept an HTTP connection';
  for (let attempt = 0; attempt < RELAY_READY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(endpoint, { redirect: 'error', signal: AbortSignal.timeout(1_000) });
      await response.body?.cancel().catch((): void => {});
      if (response.status < 500) {
        return;
      }
      lastError = `relay returned ${response.status}`;
    } catch (error: unknown) {
      lastError = errorMessage(error);
    }
    await delay(RELAY_READY_DELAY_MS);
  }
  throw new Error(`Pkarr relay was not ready at ${endpoint}: ${lastError}`);
}

function labelsMatch(
  labels: Record<string, string> | undefined,
  expected: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(expected).every(([name, value]): boolean => labels?.[name] === value);
}

/** Owns one isolated, digest-pinned Pkarr testnet and its exact Docker resources. */
export class PrivatePkarrTestnet {
  private readonly _containerName: string;
  private readonly _displayName: string;
  private readonly _labId: string;
  private readonly _networkName: string;
  private readonly _ownerId: string;
  private readonly _runId: string;
  private readonly _runner: NonNullable<PrivatePkarrTestnetDependencies['runCommand']>;
  private readonly _waitForRelay: NonNullable<PrivatePkarrTestnetDependencies['waitForRelay']>;
  private _currentRelay?: PrivatePkarrRelay;
  private _dockerVersion = '';
  private _imageInspection?: ImageInspection;
  private _lifecycleTail = Promise.resolve();
  private _networkId?: string;
  private _stopPromise?: Promise<PrivatePkarrTestnetCleanup>;

  public constructor(dependencies: PrivatePkarrTestnetDependencies = {}) {
    const randomUuid = dependencies.randomUuid ?? ((): string => crypto.randomUUID());
    this._runId = randomIdentifier(dependencies.runId ?? randomUuid(), 'runId');
    this._labId = randomIdentifier(dependencies.labId ?? randomUuid(), 'labId');
    this._ownerId = randomIdentifier(dependencies.ownerId ?? randomUuid(), 'ownerId');
    this._displayName = boundedDisplayName(dependencies.displayName ?? DEFAULT_DISPLAY_NAME);
    const runToken = token(this._runId);
    this._containerName = `enbox-did-${runToken}-pkarr`;
    this._networkName = `enbox-did-${runToken}`;
    this._runner = dependencies.runCommand ?? defaultRunCommand;
    this._waitForRelay = dependencies.waitForRelay ?? defaultWaitForRelay;
  }

  public get containerName(): string {
    return this._containerName;
  }

  public get labId(): string {
    return this._labId;
  }

  public get displayName(): string {
    return this._displayName;
  }

  public get networkName(): string {
    return this._networkName;
  }

  public get ownerId(): string {
    return this._ownerId;
  }

  public get runId(): string {
    return this._runId;
  }

  /** Checks that Docker is reachable without creating any resources. */
  public inspectDockerEngine(): Promise<DockerCommandResult> {
    return this.runLifecycle(async (): Promise<DockerCommandResult> => {
      const result = await this._runner(['docker', 'version', '--format', '{{json .}}']);
      if (result.exitCode === 0) {
        this._dockerVersion = result.stdout;
      }
      return result;
    });
  }

  /** Starts the private network and its first relay container. */
  public start(): Promise<PrivatePkarrRelay> {
    if (this._stopPromise !== undefined) {
      return Promise.reject(new Error('PrivatePkarrTestnet: cannot start while cleanup is running'));
    }
    return this.runLifecycle((): Promise<PrivatePkarrRelay> => this.performStart());
  }

  private async performStart(): Promise<PrivatePkarrRelay> {
    if (this._currentRelay !== undefined || this._networkId !== undefined) {
      throw new Error('PrivatePkarrTestnet: owned resources already exist; stop them before starting again');
    }
    if (this._dockerVersion === '') {
      throw new Error('PrivatePkarrTestnet: inspectDockerEngine() must succeed before start()');
    }

    this._imageInspection = await this.ensurePinnedImage();
    const networkId = (await expectCommand(this._runner, [
      'docker', 'network', 'create',
      '--opt', 'com.docker.network.bridge.enable_ip_masquerade=false',
      ...resourceLabelArguments(this._runId, this._labId, this._ownerId, this._displayName),
      this._networkName,
    ])).stdout.trim();
    if (networkId === '') {
      throw new Error('PrivatePkarrTestnet: docker network create returned an empty network ID');
    }
    this._networkId = networkId;
    return this.startRelay();
  }

  /** Replaces the relay container while preserving only the isolated network. */
  public restart(): Promise<PrivatePkarrRelay> {
    if (this._stopPromise !== undefined) {
      return Promise.reject(new Error('PrivatePkarrTestnet: cannot restart while cleanup is running'));
    }
    return this.runLifecycle((): Promise<PrivatePkarrRelay> => this.performRestart());
  }

  private async performRestart(): Promise<PrivatePkarrRelay> {
    const previousRelay = this._currentRelay;
    if (previousRelay === undefined) {
      throw new Error('PrivatePkarrTestnet: restart() requires a running relay');
    }

    await this.removeContainer(previousRelay.containerId);
    this._currentRelay = undefined;
    const nextRelay = await this.startRelay();
    if (nextRelay.containerId === previousRelay.containerId) {
      throw new Error(`PrivatePkarrTestnet: Docker reused container ID '${nextRelay.containerId}' during restart`);
    }
    return nextRelay;
  }

  /** Collects the immutable image, command, network, and ownership evidence. */
  public evidence(): Promise<PrivatePkarrTestnetEvidence> {
    return this.runLifecycle((): Promise<PrivatePkarrTestnetEvidence> => this.collectEvidence());
  }

  private async collectEvidence(): Promise<PrivatePkarrTestnetEvidence> {
    const image = this._imageInspection;
    const currentRelay = this._currentRelay;
    const networkId = this._networkId;
    if (image === undefined || currentRelay === undefined || networkId === undefined) {
      throw new Error('PrivatePkarrTestnet: evidence() requires a running relay');
    }
    const relay = lastJsonLine<RelayInspection>((await expectCommand(this._runner, [
      'docker', 'inspect', currentRelay.containerId, '--format', '{{json .}}',
    ])).stdout);
    const config = relay.Config;
    const network = lastJsonLine<NetworkInspection>((await expectCommand(this._runner, [
      'docker', 'network', 'inspect', networkId, '--format', '{{json .}}',
    ])).stdout);
    const imageDigestRecorded = image.RepoDigests?.includes(PKARR_RELAY_IMAGE) === true;
    const nativeImage = imageMatchesHostArchitecture(image);
    const containerLabelsMatch = labelsMatch(config?.Labels, {
      [ACTOR_LABEL]   : 'pkarr-relay',
      [DISPLAY_LABEL] : this._displayName,
      [LAB_LABEL]     : this._labId,
      [OWNER_LABEL]   : this._ownerId,
      [PROOF_LABEL]   : this._runId,
    });
    const networkLabelsMatch = labelsMatch(network.Labels, {
      [DISPLAY_LABEL] : this._displayName,
      [LAB_LABEL]     : this._labId,
      [OWNER_LABEL]   : this._ownerId,
      [PROOF_LABEL]   : this._runId,
    });
    const egressMasquerading = network.Options?.['com.docker.network.bridge.enable_ip_masquerade'] !== 'false';
    const attachedContainerIds = Object.keys(network.Containers ?? {}).sort();
    const relayAttached = attachedContainerIds.length === 1 && attachedContainerIds[0] === currentRelay.containerId;
    const attachedNetworks = Object.keys(relay.NetworkSettings?.Networks ?? {}).sort();
    const ownedNetwork = !egressMasquerading && networkLabelsMatch && relayAttached &&
      attachedNetworks.length === 1 && attachedNetworks[0] === this._networkName;
    const verified = isDigestPinnedImage(PKARR_RELAY_IMAGE) && imageDigestRecorded && nativeImage && ownedNetwork &&
      config?.Image === PKARR_RELAY_IMAGE && JSON.stringify(config.Cmd) === JSON.stringify(TESTNET_COMMAND) &&
      containerLabelsMatch;

    return {
      attachedNetworks,
      command           : config?.Cmd ?? [],
      containerImage    : config?.Image ?? '',
      displayName       : this._displayName,
      dockerVersion     : this._dockerVersion,
      egressMasquerading,
      imageArchitecture : image.Architecture ?? '',
      imageDigest       : PKARR_RELAY_IMAGE,
      imageDigestRecorded,
      imageId           : image.Id ?? '',
      imageOs           : image.Os ?? '',
      labId             : this._labId,
      nativeImage,
      ownedNetwork,
      ownerId           : this._ownerId,
      runId             : this._runId,
      verified,
    };
  }

  /** Returns relay logs when a container exists, without treating missing logs as evidence. */
  public async logs(): Promise<DockerCommandResult> {
    const containerId = this._currentRelay?.containerId;
    if (containerId === undefined) {
      return { exitCode: -1, stderr: 'PrivatePkarrTestnet: no relay container ID is available', stdout: '' };
    }
    return this._runner(['docker', 'logs', containerId]);
  }

  /** Removes only resources carrying this instance's full random ownership tuple. */
  public stop(): Promise<PrivatePkarrTestnetCleanup> {
    if (this._stopPromise === undefined) {
      const stopping = this.runLifecycle((): Promise<PrivatePkarrTestnetCleanup> => this.performStop());
      const tracked = stopping.finally((): void => {
        if (this._stopPromise === tracked) {
          this._stopPromise = undefined;
        }
      });
      this._stopPromise = tracked;
    }
    return this._stopPromise;
  }

  private async performStop(): Promise<PrivatePkarrTestnetCleanup> {
    const errors: string[] = [];
    const containers = new Set(await this.findOwnedResources('container', errors));
    if (this._currentRelay !== undefined) {
      containers.add(this._currentRelay.containerId);
    }
    for (const container of containers) {
      try {
        await this.removeContainer(container);
      } catch (error: unknown) {
        errors.push(errorMessage(error));
      }
    }

    const networks = new Set(await this.findOwnedResources('network', errors));
    if (this._networkId !== undefined) {
      networks.add(this._networkId);
    }
    for (const network of networks) {
      const result = await this._runner(['docker', 'network', 'rm', network]);
      if (result.exitCode !== 0 && !dockerResourceIsAbsent(result)) {
        errors.push(`docker network rm ${network}: ${result.stderr || result.stdout || 'no output'}`);
      }
    }

    const [containerAbsent, networkAbsent] = await Promise.all([
      this.resourcesAreAbsent('container', containers),
      this.resourcesAreAbsent('network', networks),
    ]);
    if (containerAbsent) {
      this._currentRelay = undefined;
    }
    if (networkAbsent) {
      this._networkId = undefined;
    }

    return {
      containerName : this._containerName,
      errors,
      networkName   : this._networkName,
      ownerId       : this._ownerId,
      passed        : errors.length === 0 && containerAbsent && networkAbsent,
      runId         : this._runId,
    };
  }

  private async ensurePinnedImage(): Promise<ImageInspection> {
    let inspection = await this._runner(['docker', 'image', 'inspect', PKARR_RELAY_IMAGE, '--format', '{{json .}}']);
    if (inspection.exitCode !== 0) {
      await expectCommand(this._runner, ['docker', 'pull', PKARR_RELAY_IMAGE]);
      inspection = await expectCommand(this._runner, ['docker', 'image', 'inspect', PKARR_RELAY_IMAGE, '--format', '{{json .}}']);
    }
    return lastJsonLine<ImageInspection>(inspection.stdout);
  }

  private async findOwnedResources(type: 'container' | 'network', errors: string[]): Promise<string[]> {
    const command = type === 'container'
      ? ['docker', 'ps', '--all', '--quiet', '--no-trunc']
      : ['docker', 'network', 'ls', '--quiet', '--no-trunc'];
    const result = await this._runner([...command,
      '--filter', `label=${PROOF_LABEL}=${this._runId}`,
      '--filter', `label=${LAB_LABEL}=${this._labId}`,
      '--filter', `label=${OWNER_LABEL}=${this._ownerId}`,
    ]);
    if (result.exitCode !== 0) {
      errors.push(`Unable to discover owned DID proof ${type} resources: ${result.stderr || result.stdout || 'no output'}`);
      return [];
    }
    return result.stdout.split('\n').map((entry): string => entry.trim()).filter(Boolean);
  }

  private async removeContainer(container: string): Promise<void> {
    const result = await this._runner(['docker', 'rm', '--force', container]);
    if (result.exitCode !== 0 && !dockerResourceIsAbsent(result)) {
      throw new Error(`docker rm --force ${container} failed (${result.exitCode}): ${result.stderr || result.stdout || 'no output'}`);
    }
  }

  private async startRelay(): Promise<PrivatePkarrRelay> {
    const networkId = this._networkId;
    if (networkId === undefined) {
      throw new Error('PrivatePkarrTestnet: cannot start a relay without an owned network ID');
    }
    const started = await expectCommand(this._runner, [
      'docker', 'run', '--detach',
      '--name', this._containerName,
      '--network', networkId,
      '--publish', `127.0.0.1::${RELAY_PORT}`,
      ...resourceLabelArguments(this._runId, this._labId, this._ownerId, this._displayName, 'pkarr-relay'),
      PKARR_RELAY_IMAGE,
      ...TESTNET_COMMAND,
    ]);
    const containerId = started.stdout.trim();
    if (containerId === '') {
      throw new Error('PrivatePkarrTestnet: docker run returned an empty container ID');
    }
    this._currentRelay = { containerId, endpoint: '' };
    const port = mappedRelayPort((await expectCommand(this._runner, [
      'docker', 'port', containerId, `${RELAY_PORT}/tcp`,
    ])).stdout);
    const endpoint = `http://127.0.0.1:${port}/`;
    this._currentRelay = { containerId, endpoint };
    await this._waitForRelay(endpoint);
    return this._currentRelay;
  }

  private async resourcesAreAbsent(type: 'container' | 'network', resources: ReadonlySet<string>): Promise<boolean> {
    const inspections = await Promise.all([...resources].map((resource): Promise<DockerCommandResult> => {
      const command = type === 'container'
        ? ['docker', 'inspect', resource]
        : ['docker', 'network', 'inspect', resource];
      return this._runner(command);
    }));
    return inspections.every(dockerResourceIsAbsent);
  }

  private async runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this._lifecycleTail;
    let release = (): void => {};
    const current = new Promise<void>((resolve): void => { release = resolve; });
    this._lifecycleTail = current;
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export const privatePkarrTestnetInternals = {
  mappedRelayPort,
  resourceLabelArguments,
};
