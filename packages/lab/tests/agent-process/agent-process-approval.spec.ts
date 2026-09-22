import { ConnectWorkerSessionRegistry } from '../../src/proofs/connect/connect-worker-boundary.js';
import { createTestNoteWritePopupRequest } from './test-note-write-popup.js';
import { createTestNoteWriteRelayRequest } from './test-note-write-relay.js';
import { DidServerRuntime } from '../../src/proofs/did-server/did-server-runtime.js';
import { DwnPermissionGrant } from '@enbox/agent';
import { existsSync } from 'node:fs';
import { openResponse } from '@enbox/connect';
import { startTestPkarrGateway } from './test-pkarr-gateway.js';

import {
  AgentProcessApprovalOutcomeUnknownError,
  AgentProcessRuntime,
} from '../../src/runtime/agent-process/agent-process-runtime.js';
import {
  cloneLabNoteWritePopupRequest,
  LAB_NOTE_WRITE_APP_NAME,
  LAB_NOTE_WRITE_PERMISSION_REQUEST,
  LAB_NOTE_WRITE_PROTOCOL_URI,
  LAB_NOTE_WRITE_SESSION_TTL_SECONDS,
} from '../../src/runtime/agent-process/note-write-approval.js';
import { describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName, PermissionsProtocol } from '@enbox/dwn-sdk-js';

function deferred(): Readonly<{ promise: Promise<void>; resolve(): void }> {
  let resolve = (): void => {};
  const promise = new Promise<void>((resolvePromise): void => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe('process-backed note-write approval', () => {
  it('should execute, seal, and app-open one exact real approval without exporting plaintext keys', async () => {
    const gateway = await startTestPkarrGateway('popup-approval');
    const registry = new ConnectWorkerSessionRegistry();
    const password = 'popup-approval-password-never-log';
    let runtime: AgentProcessRuntime | undefined;
    let server: DidServerRuntime | undefined;
    try {
      server = await DidServerRuntime.create(gateway.resolverEndpoint);
      runtime = await AgentProcessRuntime.create({
        actorGatewayUri : gateway.endpoint,
        remoteDwnOrigin : server.origin,
      });
      const serverEvidence = await server.start();
      expect(serverEvidence.packageVersion).toBe('0.1.43');
      expect(serverEvidence.reportedSdkVersion).toBe('0.4.27');
      const initialized = await runtime.start({ password });
      expect(gateway.server.actorObservation().admittedPuts).toBe(1);

      const fixture = await createTestNoteWritePopupRequest();
      const invalid = cloneLabNoteWritePopupRequest(fixture.request);
      invalid.permissionRequests[0]!.permissionScopes[0]!.method = DwnMethodName.Read;
      const resolverBeforeInvalid = gateway.server.resolverObservation();
      await expect(runtime.approveNoteWritePopup({
        dappOrigin : fixture.dappOrigin,
        request    : invalid,
      })).rejects.toThrow('fixed note-write policy');
      expect(gateway.server.resolverObservation()).toEqual(resolverBeforeInvalid);

      const context = { principalId: 'enbox-lab/popup-approval-test' };
      const bound = registry.bind({
        channel   : { dappOrigin: fixture.dappOrigin, kind: 'popup' },
        context,
        request   : fixture.request,
        transport : 'postMessage',
      });
      const claimed = registry.claimForApproval(context, bound.handle);
      expect((): unknown => registry.claimForApproval(context, bound.handle)).toThrow('session is invalid');

      const approving = runtime.approveNoteWritePopup({
        dappOrigin : fixture.dappOrigin,
        request    : claimed.request,
      });
      await expect(runtime.approveNoteWritePopup({
        dappOrigin : fixture.dappOrigin,
        request    : claimed.request,
      })).rejects.toThrow('approval is already in progress');
      const approval = await approving;
      expect(Object.keys(approval)).toEqual(['idToken']);
      expect(approval.idToken.split('.')).toHaveLength(5);
      expect(JSON.stringify(approval)).not.toContain(password);
      if (fixture.responsePrivateKey.d !== undefined) {
        expect(JSON.stringify(approval)).not.toContain(fixture.responsePrivateKey.d);
      }
      expect(JSON.stringify(runtime)).not.toContain(approval.idToken);

      const response = await openResponse({
        expected: {
          clientDid   : fixture.clientDid,
          nonce       : fixture.nonce,
          providerDid : initialized.agentDid,
          state       : fixture.state,
        },
        jwe                 : approval.idToken,
        recipientPrivateKey : fixture.responsePrivateKey,
      });
      expect(response.providerDid).toBe(initialized.agentDid);
      if (response.delegatePortableDid === undefined) { throw new Error('Expected the portable delegate DID.'); }
      expect(response.delegateDid).toBe(response.delegatePortableDid.uri);
      expect(response.delegatePortableDid.privateKeys?.map((key): string => key.crv ?? '').sort())
        .toEqual(['Ed25519', 'X25519']);
      expect(response.delegateGrants).toHaveLength(2);
      expect(response.sessionRevocations).toHaveLength(1);

      const grants = response.delegateGrants.map((message) => DwnPermissionGrant.parse(message));
      const sessionGrant = grants.find((grant): boolean => grant.scope.protocol === LAB_NOTE_WRITE_PROTOCOL_URI);
      if (sessionGrant === undefined) { throw new Error('Expected the note-write session grant.'); }
      const revocationGrant = grants.find((grant): boolean => grant.id !== sessionGrant.id);
      if (revocationGrant === undefined) { throw new Error('Expected the session revocation grant.'); }
      expect(sessionGrant).toMatchObject({
        delegated : true,
        grantee   : response.delegateDid,
        grantor   : initialized.agentDid,
        scope     : LAB_NOTE_WRITE_PERMISSION_REQUEST.permissionScopes[0],
      });
      expect(sessionGrant.connectSession).toMatchObject({
        appName   : LAB_NOTE_WRITE_APP_NAME,
        origin    : fixture.dappOrigin,
        transport : 'postMessage',
      });
      expect(Date.parse(sessionGrant.dateExpires) - Date.parse(sessionGrant.connectSession!.createdAt))
        .toBe(LAB_NOTE_WRITE_SESSION_TTL_SECONDS * 1_000);
      expect(revocationGrant).toMatchObject({
        delegated : true,
        grantee   : response.delegateDid,
        grantor   : initialized.agentDid,
        scope     : {
          contextId : sessionGrant.id,
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
          protocol  : PermissionsProtocol.uri,
        },
      });
      expect(response.sessionRevocations).toEqual([{
        grantId           : sessionGrant.id,
        revocationGrantId : revocationGrant.id,
      }]);
      expect(gateway.server.resolverObservation().admitted).toBeGreaterThan(0);
      expect(gateway.server.actorObservation()).toEqual({
        admittedGets : 0,
        admittedPuts : 1,
        rejected     : 0,
      });
      const identifiers = new Set(gateway.requests().flatMap((request): string[] =>
        request.identifier === undefined ? [] : [request.identifier]));
      expect([...identifiers]).toEqual([initialized.agentDid.slice('did:dht:'.length)]);

      await expect(runtime.approveNoteWritePopup({
        dappOrigin : fixture.dappOrigin,
        request    : claimed.request,
      })).rejects.toThrow('already consumed');
      expect((await runtime.stop()).agentDid).toBe(initialized.agentDid);
      expect(existsSync(runtime.storageDirectory)).toBe(true);
    } finally {
      registry.stop();
      await runtime?.destroy().catch((): void => {});
      await server?.stop().catch((): void => {});
      await gateway.close();
    }
  }, 90_000);

  it('should PIN-seal the exact direct-post approval and reject replay', async () => {
    const gateway = await startTestPkarrGateway('relay-approval');
    const pin = '4821';
    let runtime: AgentProcessRuntime | undefined;
    let server: DidServerRuntime | undefined;
    try {
      server = await DidServerRuntime.create(gateway.resolverEndpoint);
      runtime = await AgentProcessRuntime.create({
        actorGatewayUri : gateway.endpoint,
        remoteDwnOrigin : server.origin,
      });
      await server.start();
      const initialized = await runtime.start({ password: 'relay-approval-password-never-log' });
      const fixture = await createTestNoteWriteRelayRequest();
      const approval = await runtime.approveNoteWriteRelay({
        dappOrigin  : fixture.dappOrigin,
        pin,
        relayOrigin : fixture.relayOrigin,
        request     : fixture.request,
      });
      await expect(openResponse({
        expected: {
          clientDid   : fixture.clientDid,
          nonce       : fixture.nonce,
          providerDid : initialized.agentDid,
          state       : fixture.state,
        },
        jwe                 : approval.idToken,
        pin                 : '0000',
        recipientPrivateKey : fixture.responsePrivateKey,
      })).rejects.toThrow();
      const response = await openResponse({
        expected: {
          clientDid   : fixture.clientDid,
          nonce       : fixture.nonce,
          providerDid : initialized.agentDid,
          state       : fixture.state,
        },
        jwe                 : approval.idToken,
        pin,
        recipientPrivateKey : fixture.responsePrivateKey,
      });
      const sessionGrant = response.delegateGrants
        .map((message) => DwnPermissionGrant.parse(message))
        .find((grant): boolean => grant.scope.protocol === LAB_NOTE_WRITE_PROTOCOL_URI);
      expect(sessionGrant?.connectSession).toMatchObject({
        origin    : fixture.dappOrigin,
        transport : 'relay',
      });
      await expect(runtime.approveNoteWriteRelay({
        dappOrigin  : fixture.dappOrigin,
        pin,
        relayOrigin : fixture.relayOrigin,
        request     : fixture.request,
      })).rejects.toThrow('already consumed');
    } finally {
      await runtime?.destroy().catch((): void => {});
      await server?.stop().catch((): void => {});
      await gateway.close();
    }
  }, 90_000);

  it('should preserve storage and report an unknown outcome when stop times out during approval', async () => {
    const entered = deferred();
    const release = deferred();
    const remote = Bun.serve({
      fetch: async (): Promise<Response> => {
        entered.resolve();
        await release.promise;
        return new Response('released', { status: 503 });
      },
      hostname : '127.0.0.1',
      port     : 0,
    });
    const gateway = await startTestPkarrGateway('popup-approval-timeout');
    let runtime: AgentProcessRuntime | undefined;
    try {
      runtime = await AgentProcessRuntime.create({
        actorGatewayUri : gateway.endpoint,
        remoteDwnOrigin : `http://127.0.0.1:${remote.port}`,
      }, {
        approvalDrainTimeoutMs: 25,
      });
      const storageDirectory = runtime.storageDirectory;
      await runtime.start({ password: 'approval-timeout-password' });
      const fixture = await createTestNoteWritePopupRequest();
      const approval = runtime.approveNoteWritePopup({
        dappOrigin : fixture.dappOrigin,
        request    : fixture.request,
      });
      await entered.promise;
      const stopping = runtime.stop();
      const [approvalResult, stopResult] = await Promise.allSettled([approval, stopping]);
      expect(approvalResult.status).toBe('rejected');
      expect(stopResult.status).toBe('rejected');
      if (approvalResult.status === 'rejected') {
        expect(approvalResult.reason).toBeInstanceOf(AgentProcessApprovalOutcomeUnknownError);
      }
      if (stopResult.status === 'rejected') {
        expect(stopResult.reason).toBeInstanceOf(AgentProcessApprovalOutcomeUnknownError);
      }
      expect(runtime.active).toBe(false);
      expect(existsSync(storageDirectory)).toBe(true);
      await expect(runtime.approveNoteWritePopup({
        dappOrigin : fixture.dappOrigin,
        request    : fixture.request,
      })).rejects.toBeInstanceOf(AgentProcessApprovalOutcomeUnknownError);

      release.resolve();
      await expect(runtime.destroy()).rejects.toBeInstanceOf(AgentProcessApprovalOutcomeUnknownError);
      expect(existsSync(storageDirectory)).toBe(false);
      expect(await runtime.destroy()).toMatchObject({ storageRemoved: true, stopped: true });
    } finally {
      release.resolve();
      await runtime?.destroy().catch((): void => {});
      await remote.stop(true);
      await gateway.close();
    }
  }, 30_000);

  it('should quarantine later approvals when the child reports a failed ceremony', async () => {
    const remote = Bun.serve({
      fetch    : (): Response => Response.json({ error: 'fixture rejection' }, { status: 400 }),
      hostname : '127.0.0.1',
      port     : 0,
    });
    const gateway = await startTestPkarrGateway('popup-approval-failure');
    let runtime: AgentProcessRuntime | undefined;
    try {
      runtime = await AgentProcessRuntime.create({
        actorGatewayUri : gateway.endpoint,
        remoteDwnOrigin : `http://127.0.0.1:${remote.port}`,
      });
      await runtime.start({ password: 'approval-failure-password' });
      const fixture = await createTestNoteWritePopupRequest();
      await expect(runtime.approveNoteWritePopup({
        dappOrigin : fixture.dappOrigin,
        request    : fixture.request,
      })).rejects.toBeInstanceOf(AgentProcessApprovalOutcomeUnknownError);
      expect(runtime.active).toBe(true);
      await expect(runtime.approveNoteWritePopup({
        dappOrigin : fixture.dappOrigin,
        request    : fixture.request,
      })).rejects.toBeInstanceOf(AgentProcessApprovalOutcomeUnknownError);
      await expect(runtime.stop()).rejects.toBeInstanceOf(AgentProcessApprovalOutcomeUnknownError);
      expect(runtime.active).toBe(false);
      expect(existsSync(runtime.storageDirectory)).toBe(true);
    } finally {
      await runtime?.destroy().catch((): void => {});
      await remote.stop(true);
      await gateway.close();
    }
  }, 30_000);
});
