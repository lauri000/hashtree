import { describe, expect, it } from 'vitest';

import { resolveProtectedVideoState } from '../src/components/Video/videoAccess';

describe('resolveProtectedVideoState', () => {
  it('does not lock owners out of protected videos', () => {
    expect(resolveProtectedVideoState({
      isOwner: true,
      visibility: 'private',
      hasDecryptionKey: false,
      hasLinkKey: false,
    })).toBeNull();
  });

  it('does not show a protected state once a decryption key is available', () => {
    expect(resolveProtectedVideoState({
      isOwner: false,
      visibility: 'link-visible',
      hasDecryptionKey: true,
      hasLinkKey: true,
    })).toBeNull();
  });

  it('shows a link-required state when a link-visible video has no key', () => {
    expect(resolveProtectedVideoState({
      isOwner: false,
      visibility: 'link-visible',
      hasDecryptionKey: false,
      hasLinkKey: false,
    })).toEqual({
      visibility: 'link-visible',
      title: 'Link Required',
      description: 'This video requires a special link to access. Ask the owner for the link with the access key.',
      hasLinkKey: false,
    });
  });

  it('shows an invalid-link-key state when link-visible decryption fails', () => {
    expect(resolveProtectedVideoState({
      isOwner: false,
      visibility: 'link-visible',
      hasDecryptionKey: false,
      hasLinkKey: true,
    })).toEqual({
      visibility: 'link-visible',
      title: 'Invalid Link Key',
      description: 'The link key provided is invalid or has expired. Ask the owner for a new link.',
      hasLinkKey: true,
    });
  });

  it('shows a private-video state when a non-owner lacks the private key', () => {
    expect(resolveProtectedVideoState({
      isOwner: false,
      visibility: 'private',
      hasDecryptionKey: false,
      hasLinkKey: false,
    })).toEqual({
      visibility: 'private',
      title: 'Private Video',
      description: 'This video is private and can only be accessed by its owner.',
      hasLinkKey: false,
    });
  });
});
