import type { BrowserConnectObservation, BrowserConnectScenarioOutcome } from './connect-browser-types.js';
import type { LabCheck, LabProofReport } from '../../proof-result.js';

import { createProofReport } from '../../proof-result.js';
import { findChromiumExecutable } from '../../runtime/chromium.js';

export type ConnectBrowserProofOptions = {
  browserExecutablePath?: string;
  now?: () => Date;
};

export type ConnectBrowserProofDependencies = {
  findExecutable(explicitPath?: string): string | undefined;
  runScenario(executablePath: string): Promise<BrowserConnectScenarioOutcome>;
};

const UNSUPPORTED_CHECKS: readonly LabCheck[] = [
  {
    id      : 'A10-connect-private-did-network',
    status  : 'unsupported',
    summary : 'Connect approval still requires the released per-instance private DID network package cohort',
  },
  {
    id      : 'A12-wallet-agent-process-and-secret-lifecycle',
    status  : 'unsupported',
    summary : 'The denial proof does not start, unlock, lock, or reopen a real wallet agent process',
  },
  {
    id      : 'A13-wallet-agent-approval-and-response-sealing',
    status  : 'unsupported',
    summary : 'A real configured wallet agent has not approved grants or sealed an approved response',
  },
  {
    id      : 'A13-authenticated-worker-agent-channel',
    status  : 'unsupported',
    summary : 'The fixed fixture principal does not prove an authenticated gateway channel to a wallet agent process',
  },
  {
    id      : 'A13-relay-pin-approved-response',
    status  : 'unsupported',
    summary : 'PIN strengthening applies to approved relay responses and is outside this denial proof',
  },
  {
    id      : 'A14-delegated-session-lifecycle',
    status  : 'unsupported',
    summary : 'No delegated session is created by a denial-only connect proof',
  },
  {
    id      : 'A18-private-note-authorization',
    status  : 'unsupported',
    summary : 'The encrypted private-note authorization path requires a successfully approved session',
  },
  {
    id      : 'A24-connect-record-observation-equivalence',
    status  : 'unsupported',
    summary : 'Connect and record observation equivalence remains part of the integrated fixture',
  },
];

const SENSITIVE_ERROR_FIELDS = [
  'encryption_key', 'encryptionKey', 'request_uri', 'requestUri', 'requestKey',
  'walletUri', 'tokenState', 'nonce', 'state', 'id_token', 'idToken',
] as const;
const SENSITIVE_ERROR_FIELD_PATTERN = new RegExp(
  `(["']?(?:${SENSITIVE_ERROR_FIELDS.join('|')})["']?\\s*[:=]\\s*)["']?[^\\s,;"']+["']?`,
  'giu',
);

function isCanonicalHttpOrigin(value: string, hostname: '127.0.0.1' | 'localhost'): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === hostname && url.origin === value;
  } catch {
    return false;
  }
}

function redactEvidenceText(value: string): string {
  return value
    .replace(/#[^\s"'<>]*/gu, '#[redacted]')
    .replace(/(\/connect\/authorize\/)[^/\s]+\.jwt/gu, '$1[redacted].jwt')
    .replace(/(\/connect\/token\/)[^/\s]+\.jwt/gu, '$1[redacted].jwt')
    .replace(SENSITIVE_ERROR_FIELD_PATTERN, '$1[redacted]')
    .slice(0, 2_048);
}

function popupCheck(observation: BrowserConnectObservation): LabCheck {
  const passed = observation.popupDenied && observation.popupPermissionRequestCount === 0 &&
    isCanonicalHttpOrigin(observation.dappOrigin, 'localhost') &&
    isCanonicalHttpOrigin(observation.walletOrigin, 'localhost') &&
    observation.dappOrigin !== observation.walletOrigin;
  return {
    details: {
      browserVersion         : observation.browserVersion,
      dappOrigin             : observation.dappOrigin,
      executablePath         : observation.executablePath,
      permissionRequestCount : observation.popupPermissionRequestCount,
      walletOrigin           : observation.walletOrigin,
    },
    id      : 'A13-browser-popup-denial-subcheck',
    status  : passed ? 'pass' : 'fail',
    summary : passed
      ? 'Chromium completed a real encrypted popup request through the wallet worker and received a denial'
      : 'The real Chromium popup denial did not complete through the expected boundary',
  };
}

function popupBindingCheck(observation: BrowserConnectObservation): LabCheck {
  const passed = observation.popupWrongOriginIgnored && observation.popupWrongSourceIgnored &&
    observation.popupDappWrongOriginIgnored && observation.popupDappWrongSourceIgnored &&
    observation.popupOriginMismatchRejected && observation.popupOtherPrincipalRejected &&
    observation.popupOversizedEnvelopeRejected && observation.popupDenied;
  return {
    details: {
      dappWrongOriginIgnored    : observation.popupDappWrongOriginIgnored,
      dappWrongSourceIgnored    : observation.popupDappWrongSourceIgnored,
      originMismatchRejected    : observation.popupOriginMismatchRejected,
      otherPrincipalRejected    : observation.popupOtherPrincipalRejected,
      oversizedEnvelopeRejected : observation.popupOversizedEnvelopeRejected,
      walletWrongOriginIgnored  : observation.popupWrongOriginIgnored,
      walletWrongSourceIgnored  : observation.popupWrongSourceIgnored,
    },
    id      : 'A13-popup-origin-source-binding-subcheck',
    status  : passed ? 'pass' : 'fail',
    summary : passed
      ? 'The popup transport and worker session rejected foreign origin, source, request-origin, and principal substitutions'
      : 'One or more popup channel or worker-session substitutions were not rejected',
  };
}

function relayCheck(observation: BrowserConnectObservation): LabCheck {
  const statuses = observation.tokenStatuses;
  const tokenLifecyclePassed = statuses.length >= 2 && statuses.at(-1) === 200 &&
    statuses.slice(0, -1).every((status): boolean => status === 204);
  const passed = observation.relayDenied && observation.relayPermissionRequestCount === 0 &&
    observation.relayRequestPinCalls === 0 && observation.claimedObserved &&
    observation.relayRuntimeIsolated &&
    observation.authorizeStatus === 200 && observation.authorizeReplayStatus === 404 &&
    observation.callbackStatus === 201 && tokenLifecyclePassed &&
    observation.tokenConsumedStatus === 204;
  return {
    details: {
      authorizeReplayStatus  : observation.authorizeReplayStatus,
      authorizeStatus        : observation.authorizeStatus,
      callbackStatus         : observation.callbackStatus,
      claimedObserved        : observation.claimedObserved,
      permissionRequestCount : observation.relayPermissionRequestCount,
      relayServerVersion     : observation.relayServerVersion,
      requestPinCalls        : observation.relayRequestPinCalls,
      runtimeIsolated        : observation.relayRuntimeIsolated,
      tokenConsumedStatus    : observation.tokenConsumedStatus,
      tokenStatuses          : JSON.stringify(statuses),
    },
    id      : 'A13-browser-relay-denial-subcheck',
    status  : passed ? 'pass' : 'fail',
    summary : passed
      ? 'Chromium completed a real relay request and denial through the released DWN server transport'
      : 'The real browser relay denial did not satisfy its single-use route lifecycle',
  };
}

function containmentCheck(observation: BrowserConnectObservation): LabCheck {
  const passed = observation.routePolicyRejections >= 5 && observation.relayRequestKeyZeroed &&
    !observation.fragmentSecretReachedNetwork && !observation.unexpectedNetworkOrigin &&
    !observation.unexpectedRelayRoute && observation.workerMalformedCommandsRejected &&
    isCanonicalHttpOrigin(observation.relayOrigin, '127.0.0.1');
  return {
    details: {
      fragmentSecretReachedNetwork : observation.fragmentSecretReachedNetwork,
      relayOrigin                  : observation.relayOrigin,
      requestKeyZeroed             : observation.relayRequestKeyZeroed,
      routePolicyRejections        : observation.routePolicyRejections,
      unexpectedNetworkOrigin      : observation.unexpectedNetworkOrigin,
      unexpectedRelayRoute         : observation.unexpectedRelayRoute,
      workerCommandsRejected       : observation.workerMalformedCommandsRejected,
    },
    id      : 'A03-connect-relay-route-containment-subcheck',
    status  : passed ? 'pass' : 'fail',
    summary : passed
      ? 'Relay requests stayed on the exact owned origin and fragment key material never entered an HTTP URL'
      : 'The relay route policy or fragment-key containment observation failed',
  };
}

function restartCheck(observation: BrowserConnectObservation): LabCheck {
  const passed = observation.oldHandleRejectedAfterRestart &&
    observation.cancelledFlowPendingObserved && observation.pollingStoppedAfterCancellation &&
    observation.freshRelayIdentifiersDistinct && observation.relayDenied;
  return {
    details: {
      freshDenialCompleted            : observation.relayDenied,
      freshIdentifiersDistinct        : observation.freshRelayIdentifiersDistinct,
      pendingBeforeCancellation       : observation.cancelledFlowPendingObserved,
      oldHandleRejectedAfterRestart   : observation.oldHandleRejectedAfterRestart,
      pollingStoppedAfterCancellation : observation.pollingStoppedAfterCancellation,
    },
    id      : 'A13-boundary-session-restart-subcheck',
    status  : passed ? 'pass' : 'fail',
    summary : passed
      ? 'A worker restart invalidated its handle, explicit client cancellation stopped polling, and a fresh denial remained live'
      : 'The worker-restart or abandoned-client lifecycle did not fail closed',
  };
}

/** Converts secret-free live observations into the exact denial-boundary evidence contract. */
export function browserConnectObservationChecks(observation: BrowserConnectObservation): LabCheck[] {
  return [
    popupCheck(observation),
    popupBindingCheck(observation),
    relayCheck(observation),
    containmentCheck(observation),
    restartCheck(observation),
  ];
}

const defaultDependencies: ConnectBrowserProofDependencies = {
  findExecutable : findChromiumExecutable,
  runScenario    : async (executablePath): Promise<BrowserConnectScenarioOutcome> => {
    const { runConnectBrowserScenario } = await import('./connect-browser-scenario.js');
    return runConnectBrowserScenario(executablePath);
  },
};

async function runWithDependencies(
  options: ConnectBrowserProofOptions,
  dependencies: ConnectBrowserProofDependencies,
): Promise<LabProofReport> {
  const now = options.now ?? ((): Date => new Date());
  const startedAt = now();
  const executablePath = dependencies.findExecutable(options.browserExecutablePath);
  if (executablePath === undefined) {
    return createProofReport({
      checks: [
        {
          id      : 'A04-connect-browser-runtime',
          status  : 'unsupported',
          summary : 'No executable managed or supported system Chromium is available for the browser connect proof',
        },
        {
          details : { errors: '[]' },
          id      : 'browser-connect-proof-cleanup',
          status  : 'pass',
          summary : 'The connect proof created no browser resources before reporting the missing runtime',
        },
        {
          details : { errors: '[]' },
          id      : 'browser-connect-relay-runtime-cleanup',
          status  : 'pass',
          summary : 'The connect proof created no relay runtime before reporting the missing browser',
        },
        ...UNSUPPORTED_CHECKS,
      ],
      finishedAt : now(),
      proof      : 'p0-browser-connect-denial-boundary',
      startedAt,
    });
  }

  let outcome: BrowserConnectScenarioOutcome;
  try {
    outcome = await dependencies.runScenario(executablePath);
  } catch (error: unknown) {
    outcome = {
      browserCleanupErrors : ['Scenario rejected without browser cleanup evidence.'],
      executionError       : error instanceof Error ? error.message : String(error),
      relayCleanupErrors   : ['Scenario rejected without relay cleanup evidence.'],
      relayStopped         : false,
    };
  }

  const checks: LabCheck[] = [];
  if (outcome.observation !== undefined) {
    checks.push(...browserConnectObservationChecks(outcome.observation));
  }
  if (outcome.executionError !== undefined) {
    checks.push({
      details : { error: redactEvidenceText(outcome.executionError) },
      id      : 'browser-connect-proof-execution',
      status  : 'fail',
      summary : 'The real browser connect denial proof stopped before completing every observation',
    });
  }
  checks.push({
    details : { errors: JSON.stringify(outcome.browserCleanupErrors.map(redactEvidenceText)) },
    id      : 'browser-connect-proof-cleanup',
    status  : outcome.browserCleanupErrors.length === 0 ? 'pass' : 'fail',
    summary : outcome.browserCleanupErrors.length === 0
      ? 'The connect proof closed Chromium, origin servers, and generated browser bundles'
      : 'The connect proof left one or more browser-side resources open',
  });
  checks.push({
    details : { errors: JSON.stringify(outcome.relayCleanupErrors.map(redactEvidenceText)) },
    id      : 'browser-connect-relay-runtime-cleanup',
    status  : outcome.relayCleanupErrors.length === 0 && outcome.relayStopped ? 'pass' : 'fail',
    summary : outcome.relayCleanupErrors.length === 0 && outcome.relayStopped
      ? 'The released DWN server relay stopped and removed its owned runtime storage'
      : 'The connect relay did not stop cleanly',
  });
  checks.push(...UNSUPPORTED_CHECKS);

  return createProofReport({ checks, finishedAt: now(), proof: 'p0-browser-connect-denial-boundary', startedAt });
}

/** Runs the denial-only popup and relay proof without claiming wallet-agent approval. */
export function runConnectBrowserProof(options: ConnectBrowserProofOptions = {}): Promise<LabProofReport> {
  return runWithDependencies(options, defaultDependencies);
}

export const connectBrowserProofInternals = {
  runWithDependencies,
};
