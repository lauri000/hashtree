import { describe, expect, it } from 'vitest';
import { getRawHtreePath, parseImmutableHtreePath, parseMutableHtreePath } from '../src/htree-path';

describe('htree path parsing', () => {
  it('preserves slash-containing mutable tree names from encoded URLs', () => {
    const url = new URL(
      'https://git.iris.to/htree/npub1example/releases%2Fnostr-vpn/v0.3.0/assets/nostr-vpn-v0.3.0-macos-arm64.zip?htree_c=test',
    );

    expect(parseMutableHtreePath(getRawHtreePath(url))).toEqual({
      npub: 'npub1example',
      treeName: 'releases/nostr-vpn',
      filePath: 'v0.3.0/assets/nostr-vpn-v0.3.0-macos-arm64.zip',
    });
  });

  it('decodes immutable file paths segment by segment', () => {
    const url = new URL('https://git.iris.to/htree/nhash1example/clips/demo%20reel/video.mp4');

    expect(parseImmutableHtreePath(getRawHtreePath(url))).toEqual({
      nhash: 'nhash1example',
      filePath: 'clips/demo reel/video.mp4',
    });
  });
});
