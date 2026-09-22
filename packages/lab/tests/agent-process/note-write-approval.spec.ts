import type { ConnectRequest } from '@enbox/connect';

import { createTestNoteWritePopupRequest } from './test-note-write-popup.js';
import { createTestNoteWriteRelayRequest } from './test-note-write-relay.js';

import { describe, expect, it } from 'bun:test';

import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

import {
  assertLabNoteWritePopupRequest,
  assertLabNoteWriteRelayRequest,
  cloneLabNoteWritePopupRequest,
  cloneLabNoteWriteRequest,
  fingerprintLabNoteWritePopupRequest,
  LAB_NOTE_WRITE_PERMISSION_REQUEST,
  LAB_NOTE_WRITE_PROTOCOL_DEFINITION,
} from '../../src/runtime/agent-process/note-write-approval.js';

const PROVIDER_DID = `did:dht:${'y'.repeat(52)}`;

describe('fixed note-write popup approval policy', () => {
  it('should admit only the exact kernel-opened popup request and immutable write policy', async () => {
    const fixture = await createTestNoteWritePopupRequest();
    const request = cloneLabNoteWritePopupRequest(fixture.request);
    request.expectedProviderDid = PROVIDER_DID;
    request.requestType = 'connect';

    expect((): void => assertLabNoteWritePopupRequest(request, PROVIDER_DID, fixture.dappOrigin)).not.toThrow();
    expect(Object.isFrozen(LAB_NOTE_WRITE_PROTOCOL_DEFINITION)).toBe(true);
    expect(Object.isFrozen(LAB_NOTE_WRITE_PROTOCOL_DEFINITION.structure.note)).toBe(true);
    expect(LAB_NOTE_WRITE_PROTOCOL_DEFINITION.structure.note).toEqual({});
    expect(LAB_NOTE_WRITE_PERMISSION_REQUEST.permissionScopes).toEqual([{
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Write,
      protocol  : LAB_NOTE_WRITE_PROTOCOL_DEFINITION.protocol,
    }]);
  });

  it('should reject request, origin, reply, key, and policy substitutions', async () => {
    const fixture = await createTestNoteWritePopupRequest();
    const mutations: Array<(request: ConnectRequest) => void> = [
      (request): void => { request.appName = 'Substituted app'; },
      (request): void => { request.delegateDid = 'did:jwk:substituted'; },
      (request): void => { request.expectedProviderDid = `did:dht:${'o'.repeat(52)}`; },
      (request): void => { request.reply = { callbackUrl: 'http://localhost:44003/connect/callback', mode: 'direct_post' }; },
      (request): void => { request.supportedDidMethods = ['did:jwk', 'did:dht']; },
      (request): void => { request.clientMetadata!.origin = 'http://localhost:44003'; },
      (request): void => { request.permissionRequests[0]!.permissionScopes[0]!.method = DwnMethodName.Read; },
      (request): void => { Reflect.set(request.responseKey, 'd', 'private-key-must-not-cross'); },
      (request): void => { Reflect.set(request, 'extra', true); },
      (request): void => {
        Reflect.set(request.permissionRequests[0]!.protocolDefinition.structure.note, '$actions', [{
          can : ['create'],
          who : 'anyone',
        }]);
      },
    ];

    for (const mutate of mutations) {
      const request = cloneLabNoteWritePopupRequest(fixture.request);
      mutate(request);
      expect((): void => assertLabNoteWritePopupRequest(request, PROVIDER_DID, fixture.dappOrigin)).toThrow();
    }
    expect((): void => assertLabNoteWritePopupRequest(
      fixture.request,
      PROVIDER_DID,
      'http://127.0.0.1:44001',
    )).toThrow('invalid dapp origin');
  });

  it('should fingerprint a JSON-owned snapshot canonically', async () => {
    const fixture = await createTestNoteWritePopupRequest();
    const snapshot = cloneLabNoteWritePopupRequest(fixture.request);
    const reordered = Object.fromEntries(Object.entries(snapshot).reverse()) as ConnectRequest;

    expect(await fingerprintLabNoteWritePopupRequest(snapshot))
      .toBe(await fingerprintLabNoteWritePopupRequest(reordered));
    const changed = cloneLabNoteWritePopupRequest(snapshot);
    changed.state = changed.state.replace(/^./u, changed.state[0] === 'A' ? 'B' : 'A');
    expect(await fingerprintLabNoteWritePopupRequest(changed))
      .not.toBe(await fingerprintLabNoteWritePopupRequest(snapshot));

    fixture.request.permissionRequests.length = 0;
    expect(snapshot.permissionRequests).toHaveLength(1);
  });

  it('should admit only the exact direct-post callback and private relay origin', async () => {
    const fixture = await createTestNoteWriteRelayRequest();
    expect((): void => assertLabNoteWriteRelayRequest(
      fixture.request,
      PROVIDER_DID,
      fixture.dappOrigin,
      fixture.relayOrigin,
    )).not.toThrow();

    for (const mutate of [
      (request: ConnectRequest): void => {
        request.reply = { callbackUrl: `${fixture.relayOrigin}/connect/other`, mode: 'direct_post' };
      },
      (request: ConnectRequest): void => { request.reply = { mode: 'post_message' }; },
      (request: ConnectRequest): void => { request.clientMetadata!.origin = 'http://localhost:44009'; },
    ]) {
      const request = cloneLabNoteWriteRequest(fixture.request);
      mutate(request);
      expect((): void => assertLabNoteWriteRelayRequest(
        request,
        PROVIDER_DID,
        fixture.dappOrigin,
        fixture.relayOrigin,
      )).toThrow();
    }
    expect((): void => assertLabNoteWriteRelayRequest(
      fixture.request,
      PROVIDER_DID,
      fixture.dappOrigin,
      'http://localhost:44003',
    )).toThrow('invalid relay origin');
  });
});
