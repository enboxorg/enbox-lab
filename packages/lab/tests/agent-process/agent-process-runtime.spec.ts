import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';

import { describe, expect, it } from 'bun:test';

import { DidDht, getDwnEndpointStatus } from '@enbox/dids';

import { AgentProcessRuntime } from '../../src/runtime/agent-process/agent-process-runtime.js';
import { startTestPkarrGateway } from './test-pkarr-gateway.js';

const REMOTE_DWN_A = 'http://127.0.0.1:43101';
const REMOTE_DWN_B = 'http://127.0.0.1:43102';

function deferred(): Readonly<{ promise: Promise<void>; resolve(): void }> {
  let resolve = (): void => {};
  const promise = new Promise<void>((resolvePromise): void => { resolve = resolvePromise; });
  return { promise, resolve };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('released agent process runtime', () => {
  it('should isolate two private DID networks and reopen the same locked durable agents', async () => {
    // Bun 1.3.14 can race two simultaneous port-zero binds in one process.
    const gatewayA = await startTestPkarrGateway('runtime-a');
    const gatewayB = await startTestPkarrGateway('runtime-b');
    const runtimeA = await AgentProcessRuntime.create({
      actorGatewayUri : gatewayA.endpoint,
      remoteDwnOrigin : REMOTE_DWN_A,
    });
    const runtimeB = await AgentProcessRuntime.create({
      actorGatewayUri : gatewayB.endpoint,
      remoteDwnOrigin : REMOTE_DWN_B,
    });
    const passwordA = 'wallet-A-password-never-log';
    const passwordB = 'wallet-B-password-never-log';
    const inheritedGateway = process.env.DID_DHT_GATEWAY_URI;
    const inheritedPrivateOptIn = process.env.DID_DHT_ALLOW_PRIVATE_GATEWAY;
    process.env.DID_DHT_GATEWAY_URI = 'https://public-default.invalid/';
    delete process.env.DID_DHT_ALLOW_PRIVATE_GATEWAY;

    try {
      const startingA = runtimeA.start({ password: passwordA });
      await expect(runtimeA.start({ password: 'different-concurrent-password' }))
        .rejects.toThrow('start is already in progress');
      const [initializedA, initializedB] = await Promise.all([
        startingA,
        runtimeB.start({ password: passwordB }),
      ]);
      expect(initializedA).toMatchObject({
        actorGatewayUriTransport                : 'stdin-ndjson',
        childArgumentsContainActorGatewayUri    : false,
        childEnvironmentContainsActorGatewayUri : false,
        childEnvironmentKeys                    : ['NO_COLOR', 'PATH'],
        dwnEndpoints                            : [REMOTE_DWN_A],
        firstLaunch                             : true,
        localDwnStrategy                        : 'off',
        locked                                  : false,
        lockedBeforeSecret                      : true,
        mode                                    : 'initialized',
        packageName                             : '@enbox/agent',
        packageVersion                          : '0.8.48',
        passwordTransport                       : 'stdin-ndjson',
        protocolRecords                         : 2,
        published                               : true,
      });
      expect(initializedB).toMatchObject({
        dwnEndpoints : [REMOTE_DWN_B],
        firstLaunch  : true,
        mode         : 'initialized',
      });
      expect(initializedA.agentDid).not.toBe(initializedB.agentDid);
      expect(initializedA.storageDirectory).not.toBe(initializedB.storageDirectory);
      expect(runtimeA.active).toBe(true);
      expect(runtimeB.active).toBe(true);
      expect(JSON.stringify(runtimeA)).not.toContain(gatewayA.endpoint);
      expect(JSON.stringify(runtimeA)).not.toContain(passwordA);
      expect(JSON.stringify(initializedA)).not.toContain(passwordA);

      if (process.platform === 'linux') {
        const [argumentsText, environmentText] = await Promise.all([
          readFile(`/proc/${initializedA.childPid}/cmdline`, 'utf8'),
          readFile(`/proc/${initializedA.childPid}/environ`, 'utf8'),
        ]);
        expect(argumentsText).not.toContain(gatewayA.endpoint);
        expect(argumentsText).not.toContain(passwordA);
        expect(environmentText).not.toContain(gatewayA.endpoint);
        expect(environmentText).not.toContain(passwordA);
        expect(environmentText.split('\0').filter(Boolean).map((entry): string => entry.split('=', 1)[0]!).sort())
          .toEqual(['NO_COLOR', 'PATH']);
      }

      expect(gatewayA.server.actorObservation()).toEqual({
        admittedGets : 0,
        admittedPuts : 1,
        rejected     : 0,
      });
      expect(gatewayB.server.actorObservation()).toEqual({
        admittedGets : 0,
        admittedPuts : 1,
        rejected     : 0,
      });
      const resolvedA = await DidDht.resolve(initializedA.agentDid, {
        allowPrivateGatewayUri : true,
        gatewayUri             : gatewayA.endpoint,
      });
      expect(resolvedA.didResolutionMetadata.error).toBeUndefined();
      if (resolvedA.didDocument === null) {
        throw new Error('Expected the initialized agent DID to resolve.');
      }
      expect(getDwnEndpointStatus(initializedA.agentDid, resolvedA.didDocument)).toEqual({
        didUri    : initializedA.agentDid,
        endpoints : [REMOTE_DWN_A],
        status    : 'ready',
      });
      const crossLabResolution = await DidDht.resolve(initializedA.agentDid, {
        allowPrivateGatewayUri : true,
        gatewayUri             : gatewayB.endpoint,
      });
      expect(crossLabResolution.didResolutionMetadata.error).toBe('notFound');
      expect(crossLabResolution.didDocument).toBeNull();
      expect(gatewayA.server.actorObservation().admittedGets).toBe(1);
      expect(gatewayB.server.actorObservation().admittedGets).toBe(1);

      const runningPidB = runtimeB.pid;
      const stoppedA = await runtimeA.stop();
      expect(stoppedA).toMatchObject({
        agentDid         : initializedA.agentDid,
        locked           : true,
        processExited    : true,
        storagePreserved : true,
      });
      expect(runtimeB.active).toBe(true);
      expect(runtimeB.pid).toBe(runningPidB);
      expect(existsSync(initializedA.storageDirectory)).toBe(true);
      expect(existsSync(initializedB.storageDirectory)).toBe(true);

      const wrongPassword = 'wrong-password-must-never-appear';
      let wrongPasswordFailure = '';
      try {
        await runtimeA.start({ password: wrongPassword });
      } catch (error: unknown) {
        wrongPasswordFailure = error instanceof Error ? error.message : String(error);
      }
      expect(wrongPasswordFailure.length).toBeGreaterThan(0);
      expect(wrongPasswordFailure).not.toContain(wrongPassword);
      expect(runtimeA.active).toBe(false);
      expect(gatewayA.server.actorObservation()).toEqual({
        admittedGets : 1,
        admittedPuts : 1,
        rejected     : 0,
      });

      const reopenedA = await runtimeA.start({ password: passwordA });
      expect(reopenedA).toMatchObject({
        agentDid     : initializedA.agentDid,
        dwnEndpoints : [REMOTE_DWN_A],
        firstLaunch  : false,
        locked       : false,
        mode         : 'reopened',
        published    : true,
      });
      expect(gatewayA.server.actorObservation()).toEqual({
        admittedGets : 1,
        admittedPuts : 1,
        rejected     : 0,
      });
      expect(gatewayB.server.actorObservation()).toEqual({
        admittedGets : 1,
        admittedPuts : 1,
        rejected     : 0,
      });

      const identifiersA = new Set(gatewayA.requests().flatMap((request): string[] =>
        request.identifier === undefined ? [] : [request.identifier]));
      const identifiersB = new Set(gatewayB.requests().flatMap((request): string[] =>
        request.identifier === undefined ? [] : [request.identifier]));
      expect([...identifiersA]).toEqual([initializedA.agentDid.slice('did:dht:'.length)]);
      expect([...identifiersB]).toEqual([
        initializedB.agentDid.slice('did:dht:'.length),
        initializedA.agentDid.slice('did:dht:'.length),
      ]);

      const [reopenedStop, stoppedB] = await Promise.all([runtimeA.stop(), runtimeB.stop()]);
      expect(reopenedStop.agentDid).toBe(initializedA.agentDid);
      expect(stoppedB.agentDid).toBe(initializedB.agentDid);
      const [destroyedA, destroyedB] = await Promise.all([runtimeA.destroy(), runtimeB.destroy()]);
      expect(destroyedA.storageRemoved).toBe(true);
      expect(destroyedB.storageRemoved).toBe(true);
      expect(existsSync(initializedA.storageDirectory)).toBe(false);
      expect(existsSync(initializedB.storageDirectory)).toBe(false);
      await expect(runtimeA.start({ password: passwordA })).rejects.toThrow('cannot start after destroy()');
      await expect(runtimeA.stop()).rejects.toThrow('cannot stop after destroy()');
    } finally {
      await Promise.allSettled([runtimeA.destroy(), runtimeB.destroy()]);
      await Promise.allSettled([gatewayA.close(), gatewayB.close()]);
      restoreEnvironment('DID_DHT_GATEWAY_URI', inheritedGateway);
      restoreEnvironment('DID_DHT_ALLOW_PRIVATE_GATEWAY', inheritedPrivateOptIn);
    }
  }, 60_000);

  it('should cancel a stalled pre-start hook and remove storage without spawning late', async () => {
    const entered = deferred();
    const release = deferred();
    const runtime = await AgentProcessRuntime.create({
      actorGatewayUri : 'http://127.0.0.1:9/',
      remoteDwnOrigin : 'http://127.0.0.1:10',
    }, {
      beforeChildStart: async (): Promise<void> => {
        entered.resolve();
        await release.promise;
      },
    });
    const starting = runtime.start({ password: 'stalled-start-password' });
    await entered.promise;
    const storageDirectory = runtime.storageDirectory;
    const destroyed = await runtime.destroy();
    expect(destroyed).toMatchObject({ processExited: true, storageRemoved: true, stopped: true });
    expect(existsSync(storageDirectory)).toBe(false);
    await expect(starting).rejects.toThrow('start cancelled before child startup');
    release.resolve();
    await Bun.sleep(25);
    expect(runtime.pid).toBeUndefined();
    expect(existsSync(storageDirectory)).toBe(false);
  });

  it('should cancel a stalled pre-start on stop while preserving its storage', async () => {
    const entered = deferred();
    const release = deferred();
    const stopCompletionEntered = deferred();
    const releaseStopCompletion = deferred();
    const runtime = await AgentProcessRuntime.create({
      actorGatewayUri : 'http://127.0.0.1:9/',
      remoteDwnOrigin : 'http://127.0.0.1:10',
    }, {
      beforeChildStart: async (): Promise<void> => {
        entered.resolve();
        await release.promise;
      },
      beforeStopComplete: async (): Promise<void> => {
        stopCompletionEntered.resolve();
        await releaseStopCompletion.promise;
      },
    });
    const storageDirectory = runtime.storageDirectory;
    const starting = runtime.start({ password: 'stalled-stop-password' });
    await entered.promise;

    const stopping = runtime.stop();
    await expect(starting).rejects.toThrow('start cancelled before child startup');
    await stopCompletionEntered.promise;
    await expect(runtime.start({ password: 'must-not-race-stop' })).rejects.toThrow('stop is still in progress');
    releaseStopCompletion.resolve();
    expect(await stopping).toMatchObject({
      locked           : true,
      processExited    : true,
      storagePreserved : true,
    });
    expect(runtime.pid).toBeUndefined();
    expect(existsSync(storageDirectory)).toBe(true);

    release.resolve();
    await Bun.sleep(25);
    expect(runtime.pid).toBeUndefined();
    expect(existsSync(storageDirectory)).toBe(true);
    await runtime.destroy();
    expect(existsSync(storageDirectory)).toBe(false);
  });

  it('should destroy a spawned child before its secret or DID publication', async () => {
    const gateway = await startTestPkarrGateway('destroy-starting');
    const entered = deferred();
    const release = deferred();
    const runtime = await AgentProcessRuntime.create({
      actorGatewayUri : gateway.endpoint,
      remoteDwnOrigin : REMOTE_DWN_A,
    }, {
      beforeSecretSubmit: async (): Promise<void> => {
        entered.resolve();
        await release.promise;
      },
    });
    const storageDirectory = runtime.storageDirectory;
    const starting = runtime.start({ password: 'destroy-before-secret-password' });
    try {
      await entered.promise;
      expect(runtime.pid).toBeNumber();
      expect(gateway.server.actorObservation().admittedPuts).toBe(0);

      expect(await runtime.destroy()).toMatchObject({
        processExited  : true,
        storageRemoved : true,
      });
      await expect(starting).rejects.toThrow('start cancelled before secret submission');
      expect(gateway.server.actorObservation().admittedPuts).toBe(0);
      expect(runtime.pid).toBeUndefined();
      expect(existsSync(storageDirectory)).toBe(false);

      release.resolve();
      await Bun.sleep(25);
      expect(gateway.server.actorObservation().admittedPuts).toBe(0);
      expect(runtime.pid).toBeUndefined();
    } finally {
      release.resolve();
      await runtime.destroy().catch((): void => {});
      await gateway.close();
    }
  });

  it('should refuse to replace a previously observed DID after durable vault loss', async () => {
    const gateway = await startTestPkarrGateway('durable-loss');
    const runtime = await AgentProcessRuntime.create({
      actorGatewayUri : gateway.endpoint,
      remoteDwnOrigin : REMOTE_DWN_A,
    });
    const password = 'durable-state-password';
    try {
      const initialized = await runtime.start({ password });
      await runtime.stop();
      expect(gateway.server.actorObservation().admittedPuts).toBe(1);

      await rm(runtime.storageDirectory, { force: true, recursive: true });
      await mkdir(runtime.storageDirectory, { recursive: true });
      await expect(runtime.start({ password })).rejects.toThrow('durable agent vault state is missing');
      expect(gateway.server.actorObservation().admittedPuts).toBe(1);
      expect((await runtime.stop()).agentDid).toBe(initialized.agentDid);
    } finally {
      await runtime.destroy().catch((): void => {});
      await gateway.close();
    }
  });

  it('should make active and pid truthful after an unexpected child exit', async () => {
    const gateway = await startTestPkarrGateway('unexpected-exit');
    const runtime = await AgentProcessRuntime.create({
      actorGatewayUri : gateway.endpoint,
      remoteDwnOrigin : REMOTE_DWN_A,
    });
    try {
      const password = 'unexpected-exit-password';
      const initialized = await runtime.start({ password });
      process.kill(initialized.childPid, 'SIGKILL');
      for (let attempt = 0; attempt < 100 && runtime.active; attempt += 1) {
        await Bun.sleep(10);
      }
      expect(runtime.active).toBe(false);
      expect(runtime.pid).toBeUndefined();
      await expect(runtime.stop()).rejects.toThrow('did not prove a locked shutdown');
      expect(existsSync(runtime.storageDirectory)).toBe(true);
      const reopened = await runtime.start({ password });
      expect(reopened.agentDid).toBe(initialized.agentDid);
      expect(reopened.mode).toBe('reopened');
      expect((await runtime.stop()).agentDid).toBe(initialized.agentDid);
    } finally {
      await runtime.destroy().catch((): void => {});
      await gateway.close();
    }
  });

  it('should allow a failed storage removal to be retried', async () => {
    let removeAttempts = 0;
    const runtime = await AgentProcessRuntime.create({
      actorGatewayUri : 'http://127.0.0.1:9/',
      remoteDwnOrigin : 'http://127.0.0.1:10',
    }, {
      removeStorage: async (directory): Promise<void> => {
        removeAttempts += 1;
        if (removeAttempts === 1) {
          throw new Error('injected agent storage cleanup failure');
        }
        await rm(directory, { force: true, recursive: true });
      },
    });
    const storageDirectory = runtime.storageDirectory;
    await expect(runtime.destroy()).rejects.toThrow('injected agent storage cleanup failure');
    expect(existsSync(storageDirectory)).toBe(true);
    expect(await runtime.destroy()).toMatchObject({ storageRemoved: true, stopped: true });
    expect(removeAttempts).toBe(2);
    expect(existsSync(storageDirectory)).toBe(false);
  });
});
