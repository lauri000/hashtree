import { describe, expect, it } from 'vitest';
import { parseLaunchInput } from '../src/lib/launchInput';

const VALID_NPUB = 'npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm';
const VALID_NHASH = 'nhash1qqsxyn0g6yyac8ruej7r7j80y2gx6ev5z5flu6ry5h5t3ajju5utzjs9yz7t3p2syr9n5heajlv85uwej232dk5x4zqe8d7ft67y3m5umxr55qjku38';

describe('launcher input parsing', () => {
  it('parses a bare immutable nhash route', () => {
    expect(parseLaunchInput(VALID_NHASH)).toEqual({
      kind: 'immutable',
      siteKey: 'pilot',
      title: 'Isolated Site',
      nhash: VALID_NHASH,
      entryPath: 'index.html',
    });
  });

  it('parses a bare mutable npub/tree route into a tree launch', () => {
    expect(parseLaunchInput(`${VALID_NPUB}/enshittifier`)).toEqual({
      kind: 'mutable',
      siteKey: 'pilot',
      title: 'enshittifier',
      npub: VALID_NPUB,
      treeName: 'enshittifier',
      entryPath: 'index.html',
    });
  });

  it('treats additional bare mutable segments as part of the tree name', () => {
    expect(parseLaunchInput(`${VALID_NPUB}/apps/iris`)).toEqual({
      kind: 'mutable',
      siteKey: 'pilot',
      title: 'apps/iris',
      npub: VALID_NPUB,
      treeName: 'apps/iris',
      entryPath: 'index.html',
    });
  });

  it('parses launcher share URLs by their hash route', () => {
    expect(parseLaunchInput(`https://sites.iris.to/#/${VALID_NPUB}/enshittifier/index.html?menu=0`)).toEqual({
      kind: 'mutable',
      siteKey: 'pilot',
      title: 'enshittifier',
      npub: VALID_NPUB,
      treeName: 'enshittifier',
      entryPath: 'index.html',
    });
  });

  it('parses htree immutable URLs including an explicit entry path', () => {
    expect(parseLaunchInput(`htree://${VALID_NHASH}/docs/index.html`)).toEqual({
      kind: 'immutable',
      siteKey: 'pilot',
      title: 'Isolated Site',
      nhash: VALID_NHASH,
      entryPath: 'docs/index.html',
    });
  });

  it('rejects malformed input', () => {
    expect(parseLaunchInput('')).toBeNull();
    expect(parseLaunchInput('not-a-site')).toBeNull();
    expect(parseLaunchInput(VALID_NPUB)).toBeNull();
  });
});
