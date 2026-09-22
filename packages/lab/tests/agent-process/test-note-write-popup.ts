import type { ConnectRequest } from '@enbox/connect';
import type { Jwk } from '@enbox/crypto';

import { DidJwk } from '@enbox/dids';
import { X25519 } from '@enbox/crypto';

import { ConnectProvider, randomToken, sealRequest } from '@enbox/connect';
import {
  LAB_NOTE_WRITE_APP_NAME,
  LAB_NOTE_WRITE_PERMISSION_REQUEST,
} from '../../src/runtime/agent-process/note-write-approval.js';

export type TestNoteWritePopupRequest = Readonly<{
  clientDid: string;
  dappOrigin: string;
  nonce: string;
  request: ConnectRequest;
  responsePrivateKey: Jwk;
  state: string;
}>;

/** Creates and kernel-opens the exact popup request admitted by the process approval policy. */
export async function createTestNoteWritePopupRequest(
  dappOrigin = 'http://localhost:44001',
  walletOrigin = 'http://localhost:44002',
): Promise<TestNoteWritePopupRequest> {
  const clientDid = await DidJwk.create();
  const responsePrivateKey = await X25519.generateKey();
  const walletPrivateKey = await X25519.generateKey();
  const nonce = randomToken();
  const state = randomToken();
  const request: ConnectRequest = {
    appName        : LAB_NOTE_WRITE_APP_NAME,
    clientDid      : clientDid.uri,
    clientMetadata : {
      language  : 'en-US',
      languages : ['en-US', 'en'],
      origin    : dappOrigin,
      platform  : 'Enbox Lab',
      timezone  : 'Etc/UTC',
      userAgent : 'Enbox Lab popup approval test',
    },
    nonce,
    permissionRequests : [LAB_NOTE_WRITE_PERMISSION_REQUEST],
    reply              : { mode: 'post_message' },
    responseKey        : {
      crv : 'X25519',
      kty : 'OKP',
      x   : responsePrivateKey.x,
    },
    state,
    supportedDidMethods: ['did:dht', 'did:jwk'],
  };
  const jwe = await sealRequest({
    encryption: {
      mode      : 'ecdh-es',
      walletEpk : { crv: 'X25519', kty: 'OKP', x: walletPrivateKey.x },
      walletOrigin,
    },
    request,
    signer: clientDid,
  });
  const opened = await ConnectProvider.openRequest({
    decryption: {
      mode                : 'ecdh-es',
      recipientPrivateKey : walletPrivateKey,
      walletOrigin,
    },
    jwe,
  });
  return {
    clientDid : clientDid.uri,
    dappOrigin,
    nonce,
    request   : opened,
    responsePrivateKey,
    state,
  };
}
