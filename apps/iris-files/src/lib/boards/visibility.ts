import type { TreeVisibility } from '@hashtree/core';

export function resolveBoardVisibility(
  listedVisibility: TreeVisibility | undefined,
  cachedVisibility: TreeVisibility | undefined
): TreeVisibility | undefined {
  return listedVisibility ?? cachedVisibility;
}

export function isProtectedBoardWithoutAccess(
  isOwnBoard: boolean,
  hasDecryptionKey: boolean,
  visibility: TreeVisibility | undefined
): boolean {
  return !isOwnBoard
    && !hasDecryptionKey
    && (visibility === 'link-visible' || visibility === 'private');
}

export function resolveBoardPublishLabels(labels: string[] | undefined): string[] {
  const nextLabels: string[] = [];
  const seen = new Set<string>();

  for (const label of labels ?? []) {
    if (!label || seen.has(label)) continue;
    seen.add(label);
    nextLabels.push(label);
  }

  if (!seen.has('boards')) {
    nextLabels.push('boards');
  }

  return nextLabels;
}

export function resolveBoardVisibilityLinkKey(
  visibility: TreeVisibility,
  routeLinkKey: string | null | undefined,
  storedLinkKey: string | null | undefined,
  generateLinkKey: () => string
): string | undefined {
  if (visibility !== 'link-visible') return undefined;
  return routeLinkKey ?? storedLinkKey ?? generateLinkKey();
}

export function buildBoardVisibilityQueryString(
  params: URLSearchParams,
  visibility: TreeVisibility,
  linkKey?: string
): string {
  const nextParams = new URLSearchParams(params);

  if (visibility === 'link-visible' && linkKey) {
    nextParams.set('k', linkKey);
  } else {
    nextParams.delete('k');
  }

  return nextParams.toString();
}
