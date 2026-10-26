import { describe, it, expect } from 'vitest';
import {
  APP_SESSION_COOKIE,
  OperatorRegistry,
  clearSessionCookie,
  sessionCookie,
} from '../src/auth.js';

describe('OperatorRegistry', () => {
  it('extracts bearer tokens case-insensitively', () => {
    expect(OperatorRegistry.bearer('Bearer abc')).toBe('abc');
    expect(OperatorRegistry.bearer('bearer   xyz ')).toBe('xyz');
    expect(OperatorRegistry.bearer('Basic abc')).toBeUndefined();
    expect(OperatorRegistry.bearer(undefined)).toBeUndefined();
    expect(OperatorRegistry.bearer('')).toBeUndefined();
  });

  it('handles bearer tokens containing spaces only at the edges', () => {
    expect(OperatorRegistry.bearer('Bearer  tok-with-no-space ')).toBe('tok-with-no-space');
  });

  it('extracts an encoded app session cookie', () => {
    expect(OperatorRegistry.cookie(`other=1; ${APP_SESSION_COOKIE}=a%20b; x=2`)).toBe('a b');
    expect(OperatorRegistry.cookie(`${APP_SESSION_COOKIE}=`)).toBeUndefined();
    expect(OperatorRegistry.cookie(`${APP_SESSION_COOKIE}=%E0%A4%A`)).toBeUndefined();
  });

  it('builds HttpOnly app session cookies', () => {
    expect(sessionCookie('token value', false)).toBe(
      `${APP_SESSION_COOKIE}=token%20value; Path=/; HttpOnly; SameSite=Lax`,
    );
    expect(sessionCookie('token', true)).toContain('; Secure');
    expect(clearSessionCookie(false)).toContain('Max-Age=0');
  });
});
