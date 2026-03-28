export type IrisFilesAppId = 'files' | 'docs' | 'video' | 'git' | 'maps' | 'boards';

export interface AppBrand {
  id: IrisFilesAppId;
  label: string;
  displayName: string;
  iconSvg: string;
  appleTouchPng: string;
  pwa192Png: string;
  pwa512Png: string;
}

export const IRIS_FILES_APPS = ['files', 'docs', 'video', 'git', 'maps', 'boards'] as const satisfies readonly IrisFilesAppId[];

const APP_BRANDS: Record<IrisFilesAppId, AppBrand> = {
  files: {
    id: 'files',
    label: 'files',
    displayName: 'Iris Files',
    iconSvg: 'iris-files-icon.svg',
    appleTouchPng: 'iris-files-icon-180.png',
    pwa192Png: 'iris-files-icon-192.png',
    pwa512Png: 'iris-files-icon-512.png',
  },
  docs: {
    id: 'docs',
    label: 'docs',
    displayName: 'Iris Docs',
    iconSvg: 'iris-docs-icon.svg',
    appleTouchPng: 'iris-docs-icon-180.png',
    pwa192Png: 'iris-docs-icon-192.png',
    pwa512Png: 'iris-docs-icon-512.png',
  },
  video: {
    id: 'video',
    label: 'video',
    displayName: 'Iris Video',
    iconSvg: 'iris-video-icon.svg',
    appleTouchPng: 'iris-video-icon-180.png',
    pwa192Png: 'iris-video-icon-192.png',
    pwa512Png: 'iris-video-icon-512.png',
  },
  git: {
    id: 'git',
    label: 'git',
    displayName: 'Iris Git',
    iconSvg: 'iris-git-icon.svg',
    appleTouchPng: 'iris-git-icon-180.png',
    pwa192Png: 'iris-git-icon-192.png',
    pwa512Png: 'iris-git-icon-512.png',
  },
  maps: {
    id: 'maps',
    label: 'maps',
    displayName: 'Iris Maps',
    iconSvg: 'iris-maps-icon.svg',
    appleTouchPng: 'iris-maps-icon-180.png',
    pwa192Png: 'iris-maps-icon-192.png',
    pwa512Png: 'iris-maps-icon-512.png',
  },
  boards: {
    id: 'boards',
    label: 'boards',
    displayName: 'Iris Boards',
    iconSvg: 'iris-boards-icon.svg',
    appleTouchPng: 'iris-boards-icon-180.png',
    pwa192Png: 'iris-boards-icon-192.png',
    pwa512Png: 'iris-boards-icon-512.png',
  },
};

export function getAppBrand(app: IrisFilesAppId = 'files'): AppBrand {
  return APP_BRANDS[app];
}

export function getAppBrandAssetUrl(
  app: IrisFilesAppId,
  asset: keyof Pick<AppBrand, 'iconSvg' | 'appleTouchPng' | 'pwa192Png' | 'pwa512Png'>,
  baseUrl: string,
): string {
  return `${baseUrl}${getAppBrand(app)[asset]}`;
}

export function getAppPwaIcons(app: IrisFilesAppId) {
  const brand = getAppBrand(app);

  return [
    {
      src: brand.pwa192Png,
      sizes: '192x192',
      type: 'image/png',
    },
    {
      src: brand.pwa512Png,
      sizes: '512x512',
      type: 'image/png',
    },
    {
      src: brand.pwa512Png,
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any maskable',
    },
  ];
}
