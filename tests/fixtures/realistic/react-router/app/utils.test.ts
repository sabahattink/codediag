import { describe, expect, it } from 'vitest';
import { safeRedirect } from './utils';

describe('safeRedirect', () => {
  it('keeps same-site paths', () => {
    expect(safeRedirect('/projects/abc')).toBe('/projects/abc');
  });

  it('rejects other origins and protocol-relative URLs', () => {
    expect(safeRedirect('https://example.com')).toBe('/projects');
    expect(safeRedirect('//example.com')).toBe('/projects');
  });

  it('falls back when the value is missing', () => {
    expect(safeRedirect(null, '/')).toBe('/');
  });
});
