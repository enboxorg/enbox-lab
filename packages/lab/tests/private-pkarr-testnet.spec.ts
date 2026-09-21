import type { DockerCommandResult } from '../src/runtime/private-pkarr-testnet.js';

import { describe, expect, it } from 'bun:test';

import { PKARR_RELAY_IMAGE, PrivatePkarrTestnet } from '../src/runtime/private-pkarr-testnet.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const LAB_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_LAB_ID = '44444444-4444-4444-8444-444444444444';

type HarnessOptions = {
  discoveryFails?: boolean;
  egressMasquerading?: boolean;
  extraContainer?: boolean;
  extraNetwork?: boolean;
  foreignArchitecture?: boolean;
  missingDigest?: boolean;
  partialRunFailure?: boolean;
  relayDetached?: boolean;
  reuseContainerId?: boolean;
  wrongCommand?: boolean;
  wrongContainerLabels?: boolean;
  wrongNetworkLabels?: boolean;
};

type DockerHarness = {
  commands: string[][];
  containerPresent: () => boolean;
  foreignContainerPresent: () => boolean;
  foreignNetworkPresent: () => boolean;
  networkPresent: () => boolean;
  replaceContainerWithForeign: () => void;
  replaceNetworkWithForeign: () => void;
  runner: (command: string[]) => Promise<DockerCommandResult>;
};

function result(stdout = '', exitCode = 0, stderr = ''): DockerCommandResult {
  return { exitCode, stderr, stdout };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((resolvePromise): void => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createHarness(options: HarnessOptions = {}): DockerHarness {
  const commands: string[][] = [];
  let containerId = '';
  let containerPresent = false;
  let foreignContainerPresent = false;
  let foreignNetworkPresent = false;
  let networkPresent = false;
  let starts = 0;

  const runner = async (command: string[]): Promise<DockerCommandResult> => {
    commands.push(command);
    const joined = command.join(' ');
    if (joined.startsWith('docker version')) {
      return result('{"Server":{"Version":"proof"}}');
    }
    if (joined.startsWith('docker image inspect')) {
      return result(JSON.stringify({
        Architecture: options.foreignArchitecture === true
          ? process.arch === 'arm64' ? 'amd64' : 'arm64'
          : process.arch === 'arm64' ? 'arm64' : 'amd64',
        Id          : 'sha256:image-config',
        Os          : 'linux',
        RepoDigests : options.missingDigest === true ? [] : [PKARR_RELAY_IMAGE],
      }));
    }
    if (joined.startsWith('docker network create')) {
      if (foreignNetworkPresent || networkPresent) {
        return result('', 1, 'network with name already exists');
      }
      networkPresent = true;
      return result('network-id');
    }
    if (joined.startsWith('docker run')) {
      if (foreignContainerPresent) {
        return result('', 1, 'container name is already in use');
      }
      starts += 1;
      containerPresent = true;
      containerId = options.reuseContainerId === true ? 'relay-container' : `relay-container-${starts}`;
      if (options.partialRunFailure === true) {
        return result('', 1, 'container start failed after creation');
      }
      return result(containerId);
    }
    if (joined.startsWith('docker port')) {
      return result(`127.0.0.1:${41_000 + starts}`);
    }
    if (joined.startsWith('docker inspect') && joined.includes('--format {{json .}}')) {
      return result(JSON.stringify({
        Config: {
          Cmd    : options.wrongCommand === true ? ['pkarr-relay'] : ['pkarr-relay', '--testnet'],
          Image  : PKARR_RELAY_IMAGE,
          Labels : {
            'org.enbox.lab.actor-id'     : 'pkarr-relay',
            'org.enbox.lab.display-name' : 'DID Persistence Proof',
            'org.enbox.lab.lab-id'       : LAB_ID,
            'org.enbox.lab.ownership-id' : OWNER_ID,
            'org.enbox.lab.proof-run-id' : options.wrongContainerLabels === true ? '44444444-4444-4444-8444-444444444444' : RUN_ID,
          },
        },
        NetworkSettings: {
          Networks: {
            [`enbox-did-${RUN_ID.replaceAll('-', '').slice(0, 12)}`]: {},
            ...(options.extraNetwork === true ? { bridge: {} } : {}),
          },
        },
      }));
    }
    if (joined.startsWith('docker network inspect') && joined.includes('--format {{json .}}')) {
      return result(JSON.stringify({
        Containers: options.relayDetached === true
          ? {}
          : { [containerId]: {}, ...(options.extraContainer === true ? { 'foreign-container': {} } : {}) },
        Labels: {
          'org.enbox.lab.display-name' : 'DID Persistence Proof',
          'org.enbox.lab.lab-id'       : LAB_ID,
          'org.enbox.lab.ownership-id' : OWNER_ID,
          'org.enbox.lab.proof-run-id' : options.wrongNetworkLabels === true ? '44444444-4444-4444-8444-444444444444' : RUN_ID,
        },
        Options: { 'com.docker.network.bridge.enable_ip_masquerade': options.egressMasquerading === true ? 'true' : 'false' },
      }));
    }
    if (joined.startsWith('docker ps --all --quiet') || joined.startsWith('docker network ls --quiet')) {
      if (options.discoveryFails === true) {
        return result('', 1, 'daemon query failed');
      }
      if (!command.includes(`label=org.enbox.lab.lab-id=${LAB_ID}`)) {
        return result('');
      }
      if (joined.startsWith('docker ps')) {
        return result(containerPresent ? containerId : '');
      }
      return result(networkPresent ? 'network-id' : '');
    }
    if (joined.startsWith('docker rm --force')) {
      const target = command.at(-1);
      if (target === containerId && containerPresent) {
        containerPresent = false;
        return result(containerId);
      }
      if (target === `enbox-did-${RUN_ID.replaceAll('-', '').slice(0, 12)}-pkarr` && foreignContainerPresent) {
        foreignContainerPresent = false;
        return result(target);
      }
      return result('', 1, `Error: No such container: ${target}`);
    }
    if (joined.startsWith('docker network rm')) {
      const target = command.at(-1);
      if (target === 'network-id' && networkPresent) {
        networkPresent = false;
        return result('network-id');
      }
      if (target === `enbox-did-${RUN_ID.replaceAll('-', '').slice(0, 12)}` && foreignNetworkPresent) {
        foreignNetworkPresent = false;
        return result(target);
      }
      return result('', 1, `Error: No such network: ${target}`);
    }
    if (joined.startsWith('docker inspect')) {
      const target = command[2];
      const expectedName = `enbox-did-${RUN_ID.replaceAll('-', '').slice(0, 12)}-pkarr`;
      const present = target === containerId ? containerPresent : target === expectedName && foreignContainerPresent;
      return present ? result('{}') : result('', 1, `Error: No such object: ${target}`);
    }
    if (joined.startsWith('docker network inspect')) {
      const target = command[3];
      const expectedName = `enbox-did-${RUN_ID.replaceAll('-', '').slice(0, 12)}`;
      const present = target === 'network-id' ? networkPresent : target === expectedName && foreignNetworkPresent;
      return present ? result('{}') : result('', 1, `Error: No such network: ${target}`);
    }
    if (joined.startsWith('docker logs')) {
      const target = command[2];
      return target === containerId && containerPresent
        ? result('relay log')
        : result('', 1, `Error: No such container: ${target}`);
    }
    return result('', 1, `unexpected command: ${joined}`);
  };

  return {
    commands,
    containerPresent            : (): boolean => containerPresent,
    foreignContainerPresent     : (): boolean => foreignContainerPresent,
    foreignNetworkPresent       : (): boolean => foreignNetworkPresent,
    networkPresent              : (): boolean => networkPresent,
    replaceContainerWithForeign : (): void => {
      containerPresent = false;
      foreignContainerPresent = true;
    },
    replaceNetworkWithForeign: (): void => {
      networkPresent = false;
      foreignNetworkPresent = true;
    },
    runner,
  };
}

function createTestnet(
  harness: DockerHarness,
  runner: (command: string[]) => Promise<DockerCommandResult> = harness.runner,
  identifiers: readonly string[] = [RUN_ID, LAB_ID, OWNER_ID],
): PrivatePkarrTestnet {
  const uuids = [...identifiers];
  return new PrivatePkarrTestnet({
    randomUuid   : (): string => uuids.shift()!,
    runCommand   : runner,
    waitForRelay : async (): Promise<void> => {},
  });
}

describe('PrivatePkarrTestnet', () => {
  it('should own a pinned private relay, restart it with a distinct ID, and stop idempotently', async () => {
    const harness = createHarness();
    const testnet = createTestnet(harness);

    expect((await testnet.inspectDockerEngine()).exitCode).toBe(0);
    const first = await testnet.start();
    const second = await testnet.restart();
    const evidence = await testnet.evidence();
    const logs = await testnet.logs();
    const stopping = testnet.stop();
    expect(testnet.stop()).toBe(stopping);
    const firstCleanup = await stopping;
    const secondCleanup = await testnet.stop();

    expect(first.endpoint).toBe('http://127.0.0.1:41001/');
    expect(second.endpoint).toBe('http://127.0.0.1:41002/');
    expect(second.containerId).not.toBe(first.containerId);
    expect(logs).toEqual(result('relay log'));
    expect(evidence).toMatchObject({
      attachedNetworks    : ['enbox-did-111111111111'],
      displayName         : 'DID Persistence Proof',
      imageDigestRecorded : true,
      labId               : LAB_ID,
      ownedNetwork        : true,
      ownerId             : OWNER_ID,
      runId               : RUN_ID,
      verified            : true,
    });
    expect(firstCleanup.passed).toBe(true);
    expect(secondCleanup.passed).toBe(true);
    expect(harness.containerPresent()).toBe(false);
    expect(harness.networkPresent()).toBe(false);

    const networkCreate = harness.commands.find((command): boolean => command.slice(0, 3).join(' ') === 'docker network create');
    expect(networkCreate).toContain(`org.enbox.lab.ownership-id=${OWNER_ID}`);
    expect(networkCreate).toContain(`org.enbox.lab.proof-run-id=${RUN_ID}`);
    const dockerRuns = harness.commands.filter((command): boolean => command.slice(0, 2).join(' ') === 'docker run');
    expect(dockerRuns).toHaveLength(2);
    expect(dockerRuns[0]?.slice(dockerRuns[0].indexOf('--network'), dockerRuns[0].indexOf('--network') + 2))
      .toEqual(['--network', 'network-id']);
    expect(dockerRuns[0]).toContain('127.0.0.1::15411');
    expect(dockerRuns[0]?.slice(-2)).toEqual(['pkarr-relay', '--testnet']);
    expect(harness.commands).toContainEqual(['docker', 'rm', '--force', first.containerId]);
    expect(harness.commands).toContainEqual(['docker', 'port', first.containerId, '15411/tcp']);
    expect(harness.commands).toContainEqual(['docker', 'port', second.containerId, '15411/tcp']);
    expect(harness.commands).toContainEqual(['docker', 'logs', second.containerId]);
    expect(harness.commands).toContainEqual(['docker', 'inspect', second.containerId, '--format', '{{json .}}']);
    expect(harness.commands).toContainEqual(['docker', 'network', 'inspect', 'network-id', '--format', '{{json .}}']);
    expect(harness.commands).toContainEqual([
      'docker', 'ps', '--all', '--quiet', '--no-trunc',
      '--filter', `label=org.enbox.lab.proof-run-id=${RUN_ID}`,
      '--filter', `label=org.enbox.lab.lab-id=${LAB_ID}`,
      '--filter', `label=org.enbox.lab.ownership-id=${OWNER_ID}`,
    ]);
    expect(harness.commands).toContainEqual([
      'docker', 'network', 'ls', '--quiet', '--no-trunc',
      '--filter', `label=org.enbox.lab.proof-run-id=${RUN_ID}`,
      '--filter', `label=org.enbox.lab.lab-id=${LAB_ID}`,
      '--filter', `label=org.enbox.lab.ownership-id=${OWNER_ID}`,
    ]);
    expect(harness.commands.some((command): boolean => command.includes('prune'))).toBe(false);
  });

  it('should validate caller-supplied ownership IDs and display labels', () => {
    expect((): PrivatePkarrTestnet => new PrivatePkarrTestnet({
      displayName : 'bad\nlabel',
      labId       : LAB_ID,
      ownerId     : OWNER_ID,
      runId       : RUN_ID,
    })).toThrow('displayName');
    expect((): PrivatePkarrTestnet => new PrivatePkarrTestnet({
      labId   : LAB_ID,
      ownerId : OWNER_ID,
      runId   : 'predictable',
    })).toThrow('runId must be a canonical random UUID');

    const runtime = new PrivatePkarrTestnet({
      displayName : 'Private note fixture',
      labId       : LAB_ID,
      ownerId     : OWNER_ID,
      runId       : RUN_ID,
    });
    expect(runtime.displayName).toBe('Private note fixture');
    expect(runtime.labId).toBe(LAB_ID);
    expect(runtime.ownerId).toBe(OWNER_ID);
    expect(runtime.runId).toBe(RUN_ID);
  });

  it('should serialize start, concurrent start, and stop without leaking resources', async () => {
    const harness = createHarness();
    const networkCreateEntered = deferred();
    const releaseNetworkCreate = deferred();
    const runner = async (command: string[]): Promise<DockerCommandResult> => {
      if (command.slice(0, 3).join(' ') === 'docker network create') {
        networkCreateEntered.resolve();
        await releaseNetworkCreate.promise;
      }
      return harness.runner(command);
    };
    const testnet = createTestnet(harness, runner);
    await testnet.inspectDockerEngine();

    const starting = testnet.start();
    await networkCreateEntered.promise;
    const duplicateStart = testnet.start();
    const stopping = testnet.stop();
    releaseNetworkCreate.resolve();

    await starting;
    await expect(duplicateStart).rejects.toThrow('owned resources already exist');
    expect((await stopping).passed).toBe(true);
    expect(harness.containerPresent()).toBe(false);
    expect(harness.networkPresent()).toBe(false);
    expect(harness.commands.filter((command): boolean => command.slice(0, 3).join(' ') === 'docker network create')).toHaveLength(1);
  });

  it('should let an in-flight restart finish before stop removes the replacement', async () => {
    const harness = createHarness();
    const restartRunEntered = deferred();
    const releaseRestartRun = deferred();
    let dockerRuns = 0;
    const runner = async (command: string[]): Promise<DockerCommandResult> => {
      if (command.slice(0, 2).join(' ') === 'docker run') {
        dockerRuns += 1;
        if (dockerRuns === 2) {
          restartRunEntered.resolve();
          await releaseRestartRun.promise;
        }
      }
      return harness.runner(command);
    };
    const testnet = createTestnet(harness, runner);
    await testnet.inspectDockerEngine();
    await testnet.start();

    const restarting = testnet.restart();
    await restartRunEntered.promise;
    const stopping = testnet.stop();
    releaseRestartRun.resolve();

    await restarting;
    expect((await stopping).passed).toBe(true);
    expect(harness.containerPresent()).toBe(false);
    expect(harness.networkPresent()).toBe(false);
  });

  it('should discover and clean a labeled container left by a partially failed create', async () => {
    const harness = createHarness({ partialRunFailure: true });
    const testnet = createTestnet(harness);

    await testnet.inspectDockerEngine();
    await expect(testnet.start()).rejects.toThrow('container start failed after creation');
    expect(harness.containerPresent()).toBe(true);

    const cleanup = await testnet.stop();

    expect(cleanup.passed).toBe(true);
    expect(harness.containerPresent()).toBe(false);
    expect(harness.networkPresent()).toBe(false);
    expect(harness.commands).toContainEqual(['docker', 'rm', '--force', 'relay-container-1']);
  });

  it('should not delete foreign resources that replace owned resources under the expected names', async () => {
    const harness = createHarness();
    let replacedContainer = false;
    let replacedNetwork = false;
    const runner = async (command: string[]): Promise<DockerCommandResult> => {
      const commandResult = await harness.runner(command);
      if (!replacedContainer && command.slice(0, 4).join(' ') === 'docker ps --all --quiet') {
        replacedContainer = true;
        harness.replaceContainerWithForeign();
      }
      if (!replacedNetwork && command.slice(0, 4).join(' ') === 'docker network ls --quiet') {
        replacedNetwork = true;
        harness.replaceNetworkWithForeign();
      }
      return commandResult;
    };
    const testnet = createTestnet(harness, runner);
    await testnet.inspectDockerEngine();
    const relay = await testnet.start();

    const cleanup = await testnet.stop();

    expect(cleanup.passed).toBe(true);
    expect(harness.foreignContainerPresent()).toBe(true);
    expect(harness.foreignNetworkPresent()).toBe(true);
    expect(harness.commands).toContainEqual(['docker', 'rm', '--force', relay.containerId]);
    expect(harness.commands).toContainEqual(['docker', 'network', 'rm', 'network-id']);
    expect(harness.commands).toContainEqual(['docker', 'inspect', relay.containerId]);
    expect(harness.commands).toContainEqual(['docker', 'network', 'inspect', 'network-id']);
    expect(harness.commands).not.toContainEqual(['docker', 'rm', '--force', testnet.containerName]);
    expect(harness.commands).not.toContainEqual(['docker', 'network', 'rm', testnet.networkName]);
    expect(harness.commands).not.toContainEqual(['docker', 'inspect', testnet.containerName]);
    expect(harness.commands).not.toContainEqual(['docker', 'network', 'inspect', testnet.networkName]);
  });

  it('should not discover another lab that reuses the same run and owner IDs', async () => {
    const harness = createHarness();
    const first = createTestnet(harness);
    const otherLab = createTestnet(harness, harness.runner, [RUN_ID, OTHER_LAB_ID, OWNER_ID]);
    await first.inspectDockerEngine();
    await otherLab.inspectDockerEngine();
    await first.start();

    await expect(otherLab.start()).rejects.toThrow('network with name already exists');
    expect((await otherLab.stop()).passed).toBe(true);
    expect(harness.containerPresent()).toBe(true);
    expect(harness.networkPresent()).toBe(true);

    expect((await first.stop()).passed).toBe(true);
  });

  it('should leave a foreign same-name container intact when it races restart', async () => {
    const harness = createHarness();
    const testnet = createTestnet(harness);
    await testnet.inspectDockerEngine();
    const relay = await testnet.start();
    harness.replaceContainerWithForeign();

    await expect(testnet.restart()).rejects.toThrow('container name is already in use');
    const cleanup = await testnet.stop();

    expect(cleanup.passed).toBe(true);
    expect(harness.foreignContainerPresent()).toBe(true);
    expect(harness.commands).toContainEqual(['docker', 'rm', '--force', relay.containerId]);
    expect(harness.commands).not.toContainEqual(['docker', 'rm', '--force', testnet.containerName]);
  });

  it('should fail closed when a network allows masqueraded egress or cleanup discovery fails', async () => {
    const evidenceHarness = createHarness({ egressMasquerading: true });
    const evidenceTestnet = createTestnet(evidenceHarness);
    await evidenceTestnet.inspectDockerEngine();
    await evidenceTestnet.start();

    expect((await evidenceTestnet.evidence()).verified).toBe(false);
    expect((await evidenceTestnet.stop()).passed).toBe(true);

    const cleanupHarness = createHarness({ discoveryFails: true });
    const cleanupTestnet = createTestnet(cleanupHarness);
    await cleanupTestnet.inspectDockerEngine();
    await cleanupTestnet.start();
    const cleanup = await cleanupTestnet.stop();

    expect(cleanup.passed).toBe(false);
    expect(cleanup.errors).toHaveLength(2);
    expect(cleanupHarness.containerPresent()).toBe(false);
    expect(cleanupHarness.networkPresent()).toBe(false);
  });

  it('should fail evidence for every immutable image, command, label, and network mismatch', async () => {
    const cases: HarnessOptions[] = [
      { extraNetwork: true },
      { foreignArchitecture: true },
      { missingDigest: true },
      { relayDetached: true },
      { wrongCommand: true },
      { wrongContainerLabels: true },
      { wrongNetworkLabels: true },
    ];

    for (const options of cases) {
      const harness = createHarness(options);
      const testnet = createTestnet(harness);
      await testnet.inspectDockerEngine();
      await testnet.start();
      expect((await testnet.evidence()).verified).toBe(false);
      expect((await testnet.stop()).passed).toBe(true);
    }
  });

  it('should fail evidence when any additional container is attached to the owned network', async () => {
    const harness = createHarness({ extraContainer: true });
    const testnet = createTestnet(harness);
    await testnet.inspectDockerEngine();
    await testnet.start();

    expect((await testnet.evidence()).verified).toBe(false);
    expect((await testnet.stop()).passed).toBe(true);
  });

  it('should reject a restart that does not produce a distinct container ID', async () => {
    const harness = createHarness({ reuseContainerId: true });
    const testnet = createTestnet(harness);
    await testnet.inspectDockerEngine();
    await testnet.start();

    await expect(testnet.restart()).rejects.toThrow('Docker reused container ID');
    expect((await testnet.stop()).passed).toBe(true);
  });
});
