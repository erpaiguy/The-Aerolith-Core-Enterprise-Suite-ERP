import { describe, expect, it } from 'vitest';
import { apiUrlAllowed } from './api-url';

describe('apiUrlAllowed', () => {
  it('lets a packaged build use https anywhere and http only on this computer', () => {
    expect(apiUrlAllowed(new URL('https://erp.example.in'), true)).toBe(true);
    expect(apiUrlAllowed(new URL('http://localhost:8080'), true)).toBe(true);
    expect(apiUrlAllowed(new URL('http://127.0.0.1:3000'), true)).toBe(true);
    expect(apiUrlAllowed(new URL('http://[::1]:8080'), true)).toBe(true);
    expect(apiUrlAllowed(new URL('http://192.168.1.20:8080'), true)).toBe(false);
    expect(apiUrlAllowed(new URL('http://erp.example.in'), true)).toBe(false);
    expect(apiUrlAllowed(new URL('http://localhost.evil.example'), true)).toBe(false);
  });

  it('allows anything in development', () => {
    expect(apiUrlAllowed(new URL('http://192.168.1.20:8080'), false)).toBe(true);
  });
});
