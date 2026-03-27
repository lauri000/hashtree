import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShareUrlOptions, getCanonicalGitRepositoryUrl } from '../src/lib/shareUrls';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shareUrls', () => {
  it('maps hosted files routes to web and htree app URLs', () => {
    expect(createShareUrlOptions('files', 'https://files.iris.to/#/npub1owner/public/share.txt?k=abc')).toEqual([
      {
        id: 'web',
        label: 'Web URL',
        url: 'https://files.iris.to/#/npub1owner/public/share.txt?k=abc',
      },
      {
        id: 'htree',
        label: 'htree URL',
        url: 'htree://npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/files#/npub1owner/public/share.txt?k=abc',
      },
    ]);
  });

  it('replaces internal Iris child-webview origins with clean share bases', () => {
    expect(
      createShareUrlOptions(
        'video',
        'http://tree-deadbeef.htree.localhost:21417/htree/npub1app/video/index.html?iris_htree_server=http%3A%2F%2F127.0.0.1%3A21417&iris_htree_canonical=htree%3A%2F%2Fnpub1app%2Fvideo#/npub1owner/videos%252Fdemo',
      ),
    ).toEqual([
      {
        id: 'web',
        label: 'Web URL',
        url: 'https://video.iris.to/#/npub1owner/videos%252Fdemo',
      },
      {
        id: 'htree',
        label: 'htree URL',
        url: 'htree://npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/video#/npub1owner/videos%252Fdemo',
      },
    ]);
  });

  it('uses the default app URLs at the app root', () => {
    expect(createShareUrlOptions('docs', 'http://localhost:5173/#/')).toEqual([
      {
        id: 'web',
        label: 'Web URL',
        url: 'https://docs.iris.to',
      },
      {
        id: 'htree',
        label: 'htree URL',
        url: 'htree://npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/docs',
      },
    ]);
  });

  it('maps git routes to clean web and htree app URLs', () => {
    expect(createShareUrlOptions('git', 'http://127.0.0.1:5173/git.html#/npub1owner/repo?tab=pulls')).toEqual([
      {
        id: 'web',
        label: 'Web URL',
        url: 'https://git.iris.to/#/npub1owner/repo?tab=pulls',
      },
      {
        id: 'htree',
        label: 'htree URL',
        url: 'htree://npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/git#/npub1owner/repo?tab=pulls',
      },
    ]);
  });

  it('builds canonical iris-git repository URLs for web contexts by default', () => {
    expect(getCanonicalGitRepositoryUrl()).toBe(
      'https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/hashtree',
    );
    expect(getCanonicalGitRepositoryUrl('hashtree/apps/iris-files')).toBe(
      'https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/hashtree/apps/iris-files',
    );
  });

  it('uses htree repository URLs when running inside Iris native or an htree page', () => {
    vi.stubGlobal('window', {
      __HTREE_SERVER_URL__: 'http://127.0.0.1:21417',
      location: {
        protocol: 'https:',
        hostname: 'video.iris.to',
        search: '',
      },
    });

    expect(getCanonicalGitRepositoryUrl()).toBe(
      'htree://npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/git/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/hashtree',
    );

    vi.stubGlobal('window', {
      location: {
        protocol: 'htree:',
        hostname: 'self',
        search: '',
      },
    });

    expect(getCanonicalGitRepositoryUrl('hashtree/apps/iris-files')).toBe(
      'htree://npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/git/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/hashtree/apps/iris-files',
    );
  });
});
