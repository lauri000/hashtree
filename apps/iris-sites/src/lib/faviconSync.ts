export interface FaviconLinkInput {
  rel?: string | null;
  href?: string | null;
}

export interface SafeFaviconLink {
  rel: 'icon' | 'shortcut icon';
  href: string;
}

const DEFAULT_FAVICON_HREF = '/favicon.svg';
const SHELL_ICON_ID = 'iris-sites-favicon';
const SHELL_SHORTCUT_ICON_ID = 'iris-sites-shortcut-icon';

function normalizeFaviconRel(rel: string | null | undefined): SafeFaviconLink['rel'] | null {
  const normalized = (rel || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized === 'icon' || normalized === 'shortcut icon') {
    return normalized;
  }
  return null;
}

function sanitizeFaviconHref(
  href: string | null | undefined,
  baseUrl: string,
  shellOrigin: string,
): string | null {
  const trimmedHref = (href || '').trim();
  if (!trimmedHref) return null;

  let resolved: URL;
  try {
    resolved = new URL(trimmedHref, baseUrl);
  } catch {
    return null;
  }

  if ((resolved.protocol !== 'https:' && resolved.protocol !== 'http:') || resolved.origin !== shellOrigin) {
    return null;
  }

  // The isolated runtime only serves site assets from /htree/... . Rejecting
  // everything else keeps shell-level favicon mirroring from poking arbitrary
  // same-origin endpoints or accepting script/data URLs.
  if (!resolved.pathname.startsWith('/htree/')) {
    return null;
  }

  return resolved.toString();
}

export function extractSafeFaviconLinks(
  links: Iterable<FaviconLinkInput>,
  baseUrl: string,
  shellOrigin: string,
): SafeFaviconLink[] {
  const safeLinks: SafeFaviconLink[] = [];
  const seen = new Set<string>();

  for (const link of links) {
    const rel = normalizeFaviconRel(link.rel);
    if (!rel) continue;

    const href = sanitizeFaviconHref(link.href, baseUrl, shellOrigin);
    if (!href) continue;

    const key = `${rel}:${href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    safeLinks.push({ rel, href });
  }

  return safeLinks;
}

function ensureShellFaviconLink(
  shellDocument: Document,
  id: string,
  rel: SafeFaviconLink['rel'],
): HTMLLinkElement | null {
  if (!shellDocument.head) return null;

  const existing = shellDocument.getElementById(id);
  let link: HTMLLinkElement;
  if (existing instanceof HTMLLinkElement) {
    link = existing;
  } else {
    link = shellDocument.createElement('link');
    link.id = id;
    shellDocument.head.appendChild(link);
  }

  link.setAttribute('rel', rel);
  return link;
}

function setShellFaviconHref(link: HTMLLinkElement | null, href: string): void {
  if (!link) return;
  link.setAttribute('href', href);
  if (href === DEFAULT_FAVICON_HREF) {
    link.setAttribute('type', 'image/svg+xml');
    if (link.rel === 'icon') {
      link.setAttribute('sizes', 'any');
    } else {
      link.removeAttribute('sizes');
    }
    return;
  }

  link.removeAttribute('type');
  link.removeAttribute('sizes');
}

function selectFaviconHref(links: readonly SafeFaviconLink[], rel: SafeFaviconLink['rel']): string {
  return links.find((link) => link.rel === rel)?.href ?? links[0]?.href ?? DEFAULT_FAVICON_HREF;
}

export function resetShellFavicon(shellDocument: Document): void {
  const icon = ensureShellFaviconLink(shellDocument, SHELL_ICON_ID, 'icon');
  const shortcut = ensureShellFaviconLink(shellDocument, SHELL_SHORTCUT_ICON_ID, 'shortcut icon');
  setShellFaviconHref(icon, DEFAULT_FAVICON_HREF);
  setShellFaviconHref(shortcut, DEFAULT_FAVICON_HREF);
}

export function applyShellFavicon(
  shellDocument: Document,
  links: readonly SafeFaviconLink[],
): void {
  const icon = ensureShellFaviconLink(shellDocument, SHELL_ICON_ID, 'icon');
  const shortcut = ensureShellFaviconLink(shellDocument, SHELL_SHORTCUT_ICON_ID, 'shortcut icon');
  setShellFaviconHref(icon, selectFaviconHref(links, 'icon'));
  setShellFaviconHref(shortcut, selectFaviconHref(links, 'shortcut icon'));
}

function syncShellFavicon(frame: HTMLIFrameElement, shellDocument: Document): void {
  try {
    const frameDocument = frame.contentDocument;
    const frameHref = frame.contentWindow?.location.href;
    if (!frameDocument || !frameHref) {
      resetShellFavicon(shellDocument);
      return;
    }

    const links = Array.from(frameDocument.querySelectorAll('link[rel][href]')).map((link) => ({
      rel: link.getAttribute('rel'),
      href: link.getAttribute('href'),
    }));
    const safeLinks = extractSafeFaviconLinks(links, frameHref, shellDocument.location.origin);
    if (safeLinks.length === 0) {
      resetShellFavicon(shellDocument);
      return;
    }
    applyShellFavicon(shellDocument, safeLinks);
  } catch {
    resetShellFavicon(shellDocument);
  }
}

export function syncShellFaviconFromFrame(
  frame: HTMLIFrameElement,
  shellDocument: Document,
): () => void {
  syncShellFavicon(frame, shellDocument);

  try {
    const head = frame.contentDocument?.head;
    if (!head) {
      return () => {};
    }

    const observer = new MutationObserver(() => {
      syncShellFavicon(frame, shellDocument);
    });
    observer.observe(head, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['rel', 'href'],
    });
    return () => observer.disconnect();
  } catch {
    return () => {};
  }
}
