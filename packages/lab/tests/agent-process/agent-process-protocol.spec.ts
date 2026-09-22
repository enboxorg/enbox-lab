import { describe, expect, it } from 'bun:test';

import {
  AGENT_PROCESS_ACTIVE_MAX_LINE_BYTES,
  AGENT_PROCESS_CHILD_MAX_LINE_BYTES,
  parseAgentProcessChildActiveCommand,
  parseAgentProcessChildSecretCommand,
  parseAgentProcessChildStartCommand,
  parseAgentProcessChildStopCommand,
} from '../../src/runtime/agent-process/agent-process-child-protocol.js';
import {
  parseAgentProcessActive,
  parseAgentProcessAwaitingSecret,
  parseAgentProcessStopped,
  resolveAgentProcessChildEntry,
} from '../../src/runtime/agent-process/agent-process-runtime.js';

const ACTOR_GATEWAY_URI = 'http://127.0.0.1:3210/';
const REMOTE_DWN_ORIGIN = 'http://127.0.0.1:4210';
const STORAGE_DIRECTORY = '/tmp/enbox-lab-agent-protocol';
const TEST_DID = `did:dht:${'y'.repeat(52)}`;
const TEST_ID = '00000000-0000-4000-8000-000000000000';

describe('agent child command protocol', () => {
  it('should accept only canonical immutable startup configuration', () => {
    expect(parseAgentProcessChildStartCommand(JSON.stringify({
      actorGatewayUri  : ACTOR_GATEWAY_URI,
      remoteDwnOrigin  : REMOTE_DWN_ORIGIN,
      storageDirectory : STORAGE_DIRECTORY,
      type             : 'start',
    }))).toEqual({
      actorGatewayUri  : ACTOR_GATEWAY_URI,
      remoteDwnOrigin  : REMOTE_DWN_ORIGIN,
      storageDirectory : STORAGE_DIRECTORY,
      type             : 'start',
    });

    for (const invalid of [
      {
        actorGatewayUri  : ACTOR_GATEWAY_URI,
        extra            : true,
        remoteDwnOrigin  : REMOTE_DWN_ORIGIN,
        storageDirectory : STORAGE_DIRECTORY,
        type             : 'start',
      },
      {
        actorGatewayUri  : 'http://localhost:3210/',
        remoteDwnOrigin  : REMOTE_DWN_ORIGIN,
        storageDirectory : STORAGE_DIRECTORY,
        type             : 'start',
      },
      {
        actorGatewayUri  : 'http://127.0.0.1:3210',
        remoteDwnOrigin  : REMOTE_DWN_ORIGIN,
        storageDirectory : STORAGE_DIRECTORY,
        type             : 'start',
      },
      {
        actorGatewayUri  : ACTOR_GATEWAY_URI,
        remoteDwnOrigin  : `${REMOTE_DWN_ORIGIN}/`,
        storageDirectory : STORAGE_DIRECTORY,
        type             : 'start',
      },
      {
        actorGatewayUri  : ACTOR_GATEWAY_URI,
        remoteDwnOrigin  : 'https://example.com',
        storageDirectory : STORAGE_DIRECTORY,
        type             : 'start',
      },
      {
        actorGatewayUri  : ACTOR_GATEWAY_URI,
        remoteDwnOrigin  : REMOTE_DWN_ORIGIN,
        storageDirectory : 'relative/agent',
        type             : 'start',
      },
      {
        actorGatewayUri  : ACTOR_GATEWAY_URI,
        remoteDwnOrigin  : REMOTE_DWN_ORIGIN,
        storageDirectory : '/tmp/agent/../escaped',
        type             : 'start',
      },
    ]) {
      expect((): unknown => parseAgentProcessChildStartCommand(JSON.stringify(invalid)))
        .toThrow('invalid start command');
    }
  });

  it('should strictly separate the one-use secret and stop command surfaces', () => {
    expect(parseAgentProcessChildSecretCommand('{"password":"correct horse","type":"initialize"}'))
      .toEqual({ password: 'correct horse', type: 'initialize' });
    expect(parseAgentProcessChildSecretCommand('{"password":"correct horse","type":"reopen"}'))
      .toEqual({ password: 'correct horse', type: 'reopen' });
    expect(parseAgentProcessChildStopCommand('{"type":"stop"}')).toEqual({ type: 'stop' });

    for (const invalid of [
      '{"actorGatewayUri":"http://127.0.0.1:9/","password":"secret","type":"reopen"}',
      '{"password":"","type":"initialize"}',
      '{"password":"secret","type":"start"}',
      '{"password":"secret","type":"stop"}',
      '{"extra":true,"type":"stop"}',
      `${'x'.repeat(AGENT_PROCESS_CHILD_MAX_LINE_BYTES + 1)}`,
    ]) {
      if (invalid.includes('"type":"stop"')) {
        expect((): unknown => parseAgentProcessChildStopCommand(invalid)).toThrow();
      } else {
        expect((): unknown => parseAgentProcessChildSecretCommand(invalid)).toThrow();
      }
    }
  });

  it('should never include rejected secret input in parser failures', () => {
    const secret = 'never-print-this-wallet-password';
    let message = '';
    try {
      parseAgentProcessChildSecretCommand(JSON.stringify({ extra: true, password: secret, type: 'reopen' }));
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(secret);
  });

  it('should keep the larger active command surface exact and separate from secret framing', () => {
    const active = JSON.stringify({
      dappOrigin : 'http://localhost:44001',
      id         : TEST_ID,
      request    : { padding: 'x'.repeat(AGENT_PROCESS_CHILD_MAX_LINE_BYTES) },
      type       : 'approve-note-write-popup',
    });
    expect(Buffer.byteLength(active, 'utf8')).toBeGreaterThan(AGENT_PROCESS_CHILD_MAX_LINE_BYTES);
    expect(parseAgentProcessChildActiveCommand(active)).toMatchObject({
      dappOrigin : 'http://localhost:44001',
      id         : TEST_ID,
      type       : 'approve-note-write-popup',
    });
    expect(parseAgentProcessChildActiveCommand('{"type":"stop"}')).toEqual({ type: 'stop' });

    for (const invalid of [
      JSON.stringify({ dappOrigin: 'http://localhost:44001', extra: true, id: TEST_ID, request: {}, type: 'approve-note-write-popup' }),
      JSON.stringify({ dappOrigin: 'http://localhost:44001', id: 'not-a-uuid', request: {}, type: 'approve-note-write-popup' }),
      JSON.stringify({ dappOrigin: 'http://localhost:44001', id: TEST_ID, request: [], type: 'approve-note-write-popup' }),
      JSON.stringify({ dappOrigin: 'http://localhost:44001', id: TEST_ID, request: {}, type: 'sign' }),
      'x'.repeat(AGENT_PROCESS_ACTIVE_MAX_LINE_BYTES + 1),
    ]) {
      expect((): unknown => parseAgentProcessChildActiveCommand(invalid)).toThrow();
    }
  });
});

describe('agent child result protocol', () => {
  it('should accept only the exact locked, active, and stopped records', () => {
    expect(parseAgentProcessAwaitingSecret(JSON.stringify({
      firstLaunch    : true,
      locked         : true,
      packageName    : '@enbox/agent',
      packageVersion : '0.8.48',
      type           : 'awaiting-secret',
    }))).toMatchObject({ firstLaunch: true, locked: true });
    expect(parseAgentProcessActive(JSON.stringify({
      agentDid         : TEST_DID,
      dwnEndpoints     : [REMOTE_DWN_ORIGIN],
      firstLaunch      : true,
      localDwnStrategy : 'off',
      locked           : false,
      mode             : 'initialized',
      packageName      : '@enbox/agent',
      packageVersion   : '0.8.48',
      published        : true,
      type             : 'active',
    }))).toMatchObject({ agentDid: TEST_DID, mode: 'initialized', published: true });
    expect(parseAgentProcessStopped('{"locked":true,"type":"stopped"}'))
      .toEqual({ locked: true, type: 'stopped' });

    expect((): unknown => parseAgentProcessAwaitingSecret(JSON.stringify({
      firstLaunch    : true,
      locked         : false,
      packageName    : '@enbox/agent',
      packageVersion : '0.8.48',
      type           : 'awaiting-secret',
    }))).toThrow();
    expect((): unknown => parseAgentProcessActive(JSON.stringify({
      agentDid         : TEST_DID,
      dwnEndpoints     : [`${REMOTE_DWN_ORIGIN}/`],
      firstLaunch      : true,
      localDwnStrategy : 'off',
      locked           : false,
      mode             : 'initialized',
      packageName      : '@enbox/agent',
      packageVersion   : '0.8.48',
      published        : true,
      type             : 'active',
    }))).toThrow();
    expect((): unknown => parseAgentProcessStopped('{"extra":true,"locked":true,"type":"stopped"}'))
      .toThrow();
  });

  it('should resolve the colocated child source entry', async () => {
    const entry = await resolveAgentProcessChildEntry();
    expect(entry.kind).toBe('source-ts');
    expect(entry.path.endsWith('/src/runtime/agent-process/agent-process-child.ts')).toBe(true);
    expect(await Bun.file(entry.path).exists()).toBe(true);
  });
});
