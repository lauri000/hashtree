import { describe, expect, it } from 'vitest';
import { createShareUrlOptions } from '../src/lib/shareUrls';

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
        url: 'htree://npub1xndmdgymsf4a34rzr7346vp8qcptxf75pjqweh8naa8rklgxpfqqmfjtce/files#/npub1owner/public/share.txt?k=abc',
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
        url: 'htree://npub1xndmdgymsf4a34rzr7346vp8qcptxf75pjqweh8naa8rklgxpfqqmfjtce/video#/npub1owner/videos%252Fdemo',
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
        url: 'htree://npub1xndmdgymsf4a34rzr7346vp8qcptxf75pjqweh8naa8rklgxpfqqmfjtce/docs',
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
        url: 'htree://npub1xndmdgymsf4a34rzr7346vp8qcptxf75pjqweh8naa8rklgxpfqqmfjtce/git#/npub1owner/repo?tab=pulls',
      },
    ]);
  });
});
