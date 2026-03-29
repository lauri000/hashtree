import { describe, expect, it } from 'vitest';

import { decodeVideoTextFile, sanitizeVideoDescription, sanitizeVideoTitle } from '../src/lib/videoText';

describe('video text sanitization', () => {
  it('keeps normal metadata text', () => {
    expect(sanitizeVideoTitle('Original Mr Men Theme')).toBe('Original Mr Men Theme');
    expect(sanitizeVideoDescription('A clean description with timestamps 00:42')).toBe('A clean description with timestamps 00:42');
  });

  it('rejects mojibake and embedded binary markers', () => {
    expect(sanitizeVideoDescription('����\u0010JFIF\u0001\u0001ICC_PROFILEacsp')).toBe('');
  });

  it('rejects binary file contents decoded as text', () => {
    expect(
      decodeVideoTextFile(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]))
    ).toBe('');
  });
});
