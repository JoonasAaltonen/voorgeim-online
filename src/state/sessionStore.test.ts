// The session's own bookkeeping: the code you have to read aloud is yours the
// moment you ask for it, hotseat resolves intents locally, and leaving forgets
// the room.
//
// The socket is stubbed to an inert object here — the transport is *not* the
// subject, and it is covered end to end by `tools/smoke-worker.mjs`, which drives
// real sockets against a real Durable Object. A fake WebSocket asked to prove
// anything about the protocol would only be testing the fake.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CODE_LENGTH, normalizeCode } from '../net/protocol';

const stored = new Map<string, string>();
vi.stubGlobal('sessionStorage', {
  getItem: (k: string) => stored.get(k) ?? null,
  setItem: (k: string, v: string) => void stored.set(k, v),
  removeItem: (k: string) => void stored.delete(k),
});
vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
vi.stubGlobal(
  'WebSocket',
  class {
    static readonly OPEN = 1;
    readyState = 0;
    close() {}
    send() {}
  },
);

// Imported after the stubs so the module never sees a bare Node global.
const { useSession } = await import('./sessionStore');

const s = () => useSession.getState();

beforeEach(() => {
  s().leave();
  s().clearError();
  stored.clear();
});

describe('the room code', () => {
  it('is LOCAL in hotseat, which is a label rather than a room id', () => {
    expect(s().mode).toBe('local');
    expect(s().code).toBe('LOCAL');
  });

  // The regression this pins: the lobby used to read `room.code`, which is the
  // server's answer and only lands with `welcome` — so the code on screen stayed
  // "LOCAL" until the server replied, and forever if it never did.
  it('is the real code the instant you host, with no server involved', () => {
    const code = s().host();
    expect(code).toHaveLength(CODE_LENGTH);
    expect(normalizeCode(code)).toBe(code);
    expect(s().code).toBe(code);
    expect(s().mode).toBe('online');
    // No welcome has arrived, so the room is still the local one — which is
    // precisely why the code must not be read off it.
    expect(s().room.code).toBe('LOCAL');
  });

  it('is the joined code the instant you join, normalized', () => {
    expect(s().join('abc234')).toBe('ABC234');
    expect(s().code).toBe('ABC234');
  });

  it('refuses a code that is not six letters and numbers, staying local', () => {
    expect(s().join('nope')).toBeNull();
    expect(s().mode).toBe('local');
    expect(s().error).toMatch(/6 letters and numbers/i);
  });

  it('goes back to being a label on leaving', () => {
    s().host();
    s().leave();
    expect(s().code).toBe('LOCAL');
    expect(s().mode).toBe('local');
    expect(s().seat).toBeNull();
  });
});

describe('hotseat dispatch', () => {
  it('resolves an intent against the local room and bumps its version', () => {
    const before = s().room.version;
    s().dispatch({ t: 'setView', view: 'map' });
    expect(s().room.view).toBe('map');
    expect(s().room.version).toBeGreaterThan(before);
  });

  it('surfaces a refusal without touching the room', () => {
    const { room } = s();
    s().dispatch({ t: 'stratMoveLoose', unitIds: ['no-such-unit'], nodeId: 'n12' });
    expect(s().error).toBeTruthy();
    expect(s().room).toBe(room); // unchanged
  });
});

describe('leaving', () => {
  // Otherwise every later reload calls `resume()` and retries a room that is
  // not there — which is how one click of "Start online game" against a dev
  // server with no worker buried the console in refusals.
  it('forgets the session so a later reload does not retry a dead room', () => {
    s().host();
    expect(stored.get('voorgeim.session')).toBeTruthy();
    s().leave();
    expect(stored.get('voorgeim.session')).toBeUndefined();
  });

  it('does not resume when there is nothing to resume', () => {
    s().resume();
    expect(s().mode).toBe('local');
  });
});
