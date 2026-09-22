import type { ApprovedPopupBrowserObservation } from '../src/proofs/connect/approved-popup-browser-proof.js';

import { LAB_NOTE_WRITE_APP_NAME } from '../src/runtime/agent-process/note-write-approval.js';

import {
  approvedPopupBrowserVerdicts,
  runApprovedPopupBrowserProof,
} from '../src/proofs/connect/approved-popup-browser-proof.js';
import { describe, expect, it } from 'bun:test';

const DAPP_ORIGIN = 'http://localhost:44001';

function passingObservation(): ApprovedPopupBrowserObservation {
  const agentDid = `did:dht:${'y'.repeat(52)}`;
  return {
    actorGets                 : 0,
    actorPuts                 : 1,
    actorRejected             : 0,
    agentDid,
    agentPackageVersion       : '0.8.48',
    approvalAcknowledged      : true,
    bridgeApproveStatus       : 200,
    bridgeBindStatus          : 200,
    bridgeCapabilityInNetwork : false,
    bridgeRequests            : [
      { method: 'POST', url: 'http://localhost:44002/__lab/connect/popup/bind' },
      { method: 'POST', url: 'http://localhost:44002/__lab/connect/popup/approve' },
    ],
    browserVersion         : '140.0.0.0',
    connectedDid           : agentDid,
    dappOrigin             : DAPP_ORIGIN,
    delegateDid            : 'did:jwk:delegate',
    delegateGrantCount     : 2,
    delegateKeyCurves      : ['Ed25519', 'X25519'],
    permissionRequestCount : 1,
    resolverGets           : 1,
    resolverRejected       : 0,
    serverPackageVersion   : '0.1.43',
    serverSdkVersion       : '0.4.27',
    sessionRevocationCount : 1,
    walletAppName          : LAB_NOTE_WRITE_APP_NAME,
    walletOrigin           : 'http://localhost:44002',
  };
}

describe('approved popup browser proof', () => {
  it('should make every browser, bridge, and private-DID observation load-bearing', () => {
    expect(approvedPopupBrowserVerdicts(passingObservation()).map((check) => check.status))
      .toEqual(['pass', 'pass', 'pass']);
    const mutations: Array<{
      check: number;
      mutate(observation: ApprovedPopupBrowserObservation): void;
    }> = [
      { check: 0, mutate: (value): void => { Reflect.set(value, 'approvalAcknowledged', false); } },
      { check: 0, mutate: (value): void => { Reflect.set(value, 'delegateGrantCount', 1); } },
      { check: 0, mutate: (value): void => { Reflect.set(value, 'sessionRevocationCount', 0); } },
      { check: 0, mutate: (value): void => { Reflect.set(value, 'connectedDid', 'did:dht:other'); } },
      { check: 0, mutate: (value): void => { Reflect.set(value, 'agentDid', 'did:dht:invalid'); } },
      { check: 0, mutate: (value): void => { Reflect.set(value, 'delegateDid', 'did:dht:delegate'); } },
      { check: 0, mutate: (value): void => { Reflect.set(value, 'delegateKeyCurves', ['Ed25519']); } },
      { check: 0, mutate: (value): void => { Reflect.set(value, 'browserVersion', ''); } },
      { check: 0, mutate: (value): void => { Reflect.set(value, 'permissionRequestCount', 0); } },
      { check: 0, mutate: (value): void => { Reflect.set(value, 'walletAppName', 'substituted'); } },
      { check: 1, mutate: (value): void => { Reflect.set(value, 'bridgeBindStatus', 409); } },
      { check: 1, mutate: (value): void => { Reflect.set(value, 'bridgeApproveStatus', 409); } },
      { check: 1, mutate: (value): void => { Reflect.set(value, 'bridgeCapabilityInNetwork', true); } },
      { check: 1, mutate: (value): void => { Reflect.set(value, 'bridgeRequests', []); } },
      { check  : 1, mutate : (value): void => { Reflect.set(value, 'bridgeRequests', [
        { method: 'POST', url: 'not-a-url' },
        { method: 'POST', url: 'also-not-a-url' },
      ]); } },
      { check  : 1, mutate : (value): void => { Reflect.set(value, 'bridgeRequests', [
        { method: 'GET', url: 'http://localhost:44002/__lab/connect/popup/bind' },
        { method: 'POST', url: 'http://localhost:44002/__lab/connect/popup/approve' },
      ]); } },
      { check  : 1, mutate : (value): void => { Reflect.set(value, 'bridgeRequests', [
        { method: 'POST', url: 'http://localhost:44002/__lab/connect/popup/cancel' },
        { method: 'POST', url: 'http://localhost:44002/__lab/connect/popup/approve' },
      ]); } },
      { check: 1, mutate: (value): void => { Reflect.set(value, 'walletOrigin', DAPP_ORIGIN); } },
      { check: 1, mutate: (value): void => { Reflect.set(value, 'dappOrigin', 'https://example.com'); } },
      { check: 1, mutate: (value): void => { Reflect.set(value, 'walletOrigin', 'https://example.com'); } },
      { check: 2, mutate: (value): void => { Reflect.set(value, 'actorGets', 1); } },
      { check: 2, mutate: (value): void => { Reflect.set(value, 'actorPuts', 0); } },
      { check: 2, mutate: (value): void => { Reflect.set(value, 'actorRejected', 1); } },
      { check: 2, mutate: (value): void => { Reflect.set(value, 'resolverGets', 0); } },
      { check: 2, mutate: (value): void => { Reflect.set(value, 'resolverRejected', 1); } },
      { check: 2, mutate: (value): void => { Reflect.set(value, 'agentPackageVersion', 'wrong'); } },
      { check: 2, mutate: (value): void => { Reflect.set(value, 'serverPackageVersion', 'wrong'); } },
      { check: 2, mutate: (value): void => { Reflect.set(value, 'serverSdkVersion', 'wrong'); } },
    ];
    for (const { check, mutate } of mutations) {
      const observation = structuredClone(passingObservation()) as ApprovedPopupBrowserObservation;
      mutate(observation);
      expect(approvedPopupBrowserVerdicts(observation)[check]!.status).toBe('fail');
    }
  });

  it('should preserve a missing explicit browser as unsupported without opening Docker resources', async () => {
    const report = await runApprovedPopupBrowserProof({ browserExecutablePath: '/definitely/missing/chromium' });
    expect(report).toMatchObject({
      checks : [{ id: 'A04-browser-popup-approval-chromium', status: 'unsupported' }],
      proof  : 'p0-browser-popup-approval',
      status : 'unsupported',
    });
  });
});
