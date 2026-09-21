import type { BrowserConnectObservation } from '../src/proofs/connect/connect-browser-types.js';

import { describe, expect, it } from 'bun:test';

import {
  browserConnectObservationChecks,
  connectBrowserProofInternals,
  runConnectBrowserProof,
} from '../src/proofs/connect/connect-browser-proof.js';

function passingObservation(): BrowserConnectObservation {
  return {
    authorizeReplayStatus           : 404,
    authorizeStatus                 : 200,
    browserVersion                  : 'test-browser',
    callbackStatus                  : 201,
    cancelledFlowPendingObserved    : true,
    claimedObserved                 : true,
    dappOrigin                      : 'http://localhost:41001',
    executablePath                  : '/test/chromium',
    fragmentSecretReachedNetwork    : false,
    freshRelayIdentifiersDistinct   : true,
    oldHandleRejectedAfterRestart   : true,
    pollingStoppedAfterCancellation : true,
    popupDenied                     : true,
    popupDappWrongOriginIgnored     : true,
    popupDappWrongSourceIgnored     : true,
    popupOriginMismatchRejected     : true,
    popupOtherPrincipalRejected     : true,
    popupOversizedEnvelopeRejected  : true,
    popupPermissionRequestCount     : 0,
    popupWrongOriginIgnored         : true,
    popupWrongSourceIgnored         : true,
    relayDenied                     : true,
    relayOrigin                     : 'http://127.0.0.1:41003',
    relayPermissionRequestCount     : 0,
    relayRequestKeyZeroed           : true,
    relayRequestPinCalls            : 0,
    relayRuntimeIsolated            : true,
    relayServerVersion              : '0.1.43',
    routePolicyRejections           : 5,
    tokenConsumedStatus             : 204,
    tokenStatuses                   : [204, 200],
    unexpectedNetworkOrigin         : false,
    unexpectedRelayRoute            : false,
    walletOrigin                    : 'http://localhost:41002',
    workerMalformedCommandsRejected : true,
  };
}

describe('browser connect denial proof', () => {
  it('should map a complete secret-free observation to the five functional passes', () => {
    expect(browserConnectObservationChecks(passingObservation())).toEqual([
      expect.objectContaining({ id: 'A13-browser-popup-denial-subcheck', status: 'pass' }),
      expect.objectContaining({ id: 'A13-popup-origin-source-binding-subcheck', status: 'pass' }),
      expect.objectContaining({ id: 'A13-browser-relay-denial-subcheck', status: 'pass' }),
      expect.objectContaining({ id: 'A03-connect-relay-route-containment-subcheck', status: 'pass' }),
      expect.objectContaining({ id: 'A13-boundary-session-restart-subcheck', status: 'pass' }),
    ]);
  });

  it('should fail each functional verdict when its required evidence is incomplete', () => {
    const cases: Array<[keyof BrowserConnectObservation, BrowserConnectObservation[keyof BrowserConnectObservation], string]> = [
      ['popupDenied', false, 'A13-browser-popup-denial-subcheck'],
      ['dappOrigin', 'http://127.0.0.1.attacker.example', 'A13-browser-popup-denial-subcheck'],
      ['popupWrongSourceIgnored', false, 'A13-popup-origin-source-binding-subcheck'],
      ['popupDappWrongOriginIgnored', false, 'A13-popup-origin-source-binding-subcheck'],
      ['popupDappWrongSourceIgnored', false, 'A13-popup-origin-source-binding-subcheck'],
      ['popupOversizedEnvelopeRejected', false, 'A13-popup-origin-source-binding-subcheck'],
      ['authorizeReplayStatus', 200, 'A13-browser-relay-denial-subcheck'],
      ['relayRequestPinCalls', 1, 'A13-browser-relay-denial-subcheck'],
      ['tokenStatuses', [204, 500, 200], 'A13-browser-relay-denial-subcheck'],
      ['fragmentSecretReachedNetwork', true, 'A03-connect-relay-route-containment-subcheck'],
      ['relayRequestKeyZeroed', false, 'A03-connect-relay-route-containment-subcheck'],
      ['routePolicyRejections', 4, 'A03-connect-relay-route-containment-subcheck'],
      ['relayOrigin', 'http://127.0.0.1.attacker.example', 'A03-connect-relay-route-containment-subcheck'],
      ['unexpectedNetworkOrigin', true, 'A03-connect-relay-route-containment-subcheck'],
      ['unexpectedRelayRoute', true, 'A03-connect-relay-route-containment-subcheck'],
      ['workerMalformedCommandsRejected', false, 'A03-connect-relay-route-containment-subcheck'],
      ['oldHandleRejectedAfterRestart', false, 'A13-boundary-session-restart-subcheck'],
      ['cancelledFlowPendingObserved', false, 'A13-boundary-session-restart-subcheck'],
      ['freshRelayIdentifiersDistinct', false, 'A13-boundary-session-restart-subcheck'],
      ['pollingStoppedAfterCancellation', false, 'A13-boundary-session-restart-subcheck'],
    ];

    for (const [key, value, expectedId] of cases) {
      const observation = { ...passingObservation(), [key]: value } as BrowserConnectObservation;
      expect(browserConnectObservationChecks(observation)).toContainEqual(expect.objectContaining({
        id     : expectedId,
        status : 'fail',
      }));
    }
  });

  it('should compose exact pass, cleanup, and unsupported checks without serializing secrets', async () => {
    const report = await connectBrowserProofInternals.runWithDependencies({}, {
      findExecutable : (): string => '/test/chromium',
      runScenario    : async () => ({
        browserCleanupErrors : [],
        observation          : passingObservation(),
        relayCleanupErrors   : [],
        relayStopped         : true,
      }),
    });

    expect(report.proof).toBe('p0-browser-connect-denial-boundary');
    expect(report.status).toBe('unsupported');
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'browser-connect-proof-cleanup', status: 'pass' }));
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'browser-connect-relay-runtime-cleanup', status: 'pass' }));
    expect(report.checks.filter((check): boolean => check.status === 'unsupported')).toHaveLength(8);
    const serialized = JSON.stringify(report);
    for (const secretField of ['"walletUri":', '"requestUri":', '"tokenState":', '"handle":', '"nonce":', '"encryptionKey":']) {
      expect(serialized).not.toContain(secretField);
    }
  });

  it('should preserve execution and both cleanup failures', async () => {
    const report = await connectBrowserProofInternals.runWithDependencies({}, {
      findExecutable : (): string => '/test/chromium',
      runScenario    : async () => ({
        browserCleanupErrors : ['browser still open requestUri=VISIBLE-BROWSER-SECRET'],
        executionError       : 'failed {"encryptionKey":"VISIBLE-JSON-SECRET"} at https://wallet.test/#encryption_key=VISIBLE-FRAGMENT-SECRET',
        relayCleanupErrors   : ['relay idToken=VISIBLE-ID-TOKEN /connect/token/VISIBLE-TOKEN-SECRET.jwt still live'],
        relayStopped         : false,
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'browser-connect-proof-execution', status: 'fail' }),
      expect.objectContaining({ id: 'browser-connect-proof-cleanup', status: 'fail' }),
      expect.objectContaining({ id: 'browser-connect-relay-runtime-cleanup', status: 'fail' }),
    ]));
    expect(JSON.stringify(report)).not.toContain('VISIBLE-');
    expect(JSON.stringify(report)).toContain('[redacted]');
  });

  it('should convert an unexpected scenario rejection into failed evidence', async () => {
    const report = await connectBrowserProofInternals.runWithDependencies({}, {
      findExecutable : (): string => '/test/chromium',
      runScenario    : async (): Promise<never> => { throw new Error('scenario rejected'); },
    });

    expect(report.status).toBe('fail');
    expect(report.checks).toContainEqual(expect.objectContaining({
      details : { error: 'scenario rejected' },
      id      : 'browser-connect-proof-execution',
      status  : 'fail',
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'browser-connect-proof-cleanup', status: 'fail' }));
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'browser-connect-relay-runtime-cleanup', status: 'fail' }));
  });

  it('should report a missing explicit browser without starting the relay', async () => {
    const report = await runConnectBrowserProof({ browserExecutablePath: '/definitely/missing/chromium' });

    expect(report.status).toBe('unsupported');
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'A04-connect-browser-runtime', status: 'unsupported' }),
      expect.objectContaining({ id: 'browser-connect-proof-cleanup', status: 'pass' }),
      expect.objectContaining({ id: 'browser-connect-relay-runtime-cleanup', status: 'pass' }),
    ]));
    expect(report.checks.filter((check): boolean => check.status === 'unsupported')).toHaveLength(9);
  });
});
