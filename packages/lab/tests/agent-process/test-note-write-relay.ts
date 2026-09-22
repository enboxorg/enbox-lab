import type { ConnectRequest } from '@enbox/connect';
import type { Jwk } from '@enbox/crypto';

import { DidJwk } from '@enbox/dids';
import { X25519 } from '@enbox/crypto';

import { ConnectProvider, randomToken, sealRequest } from '@enbox/connect';

import {
  LAB_NOTE_WRITE_APP_NAME,
  LAB_NOTE_WRITE_PERMISSION_REQUEST,
} from '../../src/runtime/agent-process/note-write-approval.js';

export type TestNoteWriteRelayRequest = Readonly<{
  clientDid: string;
  dappOrigin: string;
  nonce: string;
  relayOrigin: string;
  request: ConnectRequest;
  requestKey: Uint8Array;
  responsePrivateKey: Jwk;
  state: string;
}>;

/** Creates and kernel-opens the exact direct-post request admitted by the relay policy. */
export async function createTestNoteWriteRelayRequest(
  dappOrigin = 'http://localhost:44001',
  relayOrigin = 'http://127.0.0.1:44003',
): Promise<TestNoteWriteRelayRequest> {
  const clientDid = await DidJwk.create();
  const responsePrivateKey = await X25519.generateKey();
  const requestKey = crypto.getRandomValues(new Uint8Array(32));
  const nonce = randomToken();
  const state = randomToken();
  const request: ConnectRequest = {
    appName             : LAB_NOTE_WRITE_APP_NAME,
    clientDid           : clientDid.uri,
    clientMetadata      : { origin: dappOrigin, userAgent: 'Enbox Lab relay approval test' },
    nonce,
    permissionRequests  : [LAB_NOTE_WRITE_PERMISSION_REQUEST],
    reply               : { callbackUrl: `${relayOrigin}/connect/callback`, mode: 'direct_post' },
    responseKey         : { crv: 'X25519', kty: 'OKP', x: responsePrivateKey.x },
    state,
    supportedDidMethods : ['did:dht', 'did:jwk'],
  };
  const jwe = await sealRequest({
    encryption : { mode: 'dir', requestKey },
    request,
    signer     : clientDid,
  });
  const opened = await ConnectProvider.openRequest({
    decryption: { mode: 'dir', requestKey },
    jwe,
  });
  return {
    clientDid : clientDid.uri,
    dappOrigin,
    nonce,
    relayOrigin,
    request   : opened,
    requestKey,
    responsePrivateKey,
    state,
  };
}
