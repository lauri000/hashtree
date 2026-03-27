import type { TreeVisibility } from '@hashtree/core';

export type ProtectedVideoState = {
  visibility: 'link-visible' | 'private';
  title: string;
  description: string;
  hasLinkKey: boolean;
};

export function resolveProtectedVideoState(options: {
  isOwner: boolean;
  visibility: TreeVisibility | null | undefined;
  hasDecryptionKey: boolean;
  hasLinkKey: boolean;
}): ProtectedVideoState | null {
  const { isOwner, visibility, hasDecryptionKey, hasLinkKey } = options;

  if (isOwner || hasDecryptionKey) return null;

  if (visibility === 'link-visible') {
    return {
      visibility,
      title: hasLinkKey ? 'Invalid Link Key' : 'Link Required',
      description: hasLinkKey
        ? 'The link key provided is invalid or has expired. Ask the owner for a new link.'
        : 'This video requires a special link to access. Ask the owner for the link with the access key.',
      hasLinkKey,
    };
  }

  if (visibility === 'private') {
    return {
      visibility,
      title: 'Private Video',
      description: 'This video is private and can only be accessed by its owner.',
      hasLinkKey,
    };
  }

  return null;
}
