import { defineConfig, presetUno, presetIcons } from 'unocss';

export default defineConfig({
  safelist: [
    'i-lucide-upload',
    'i-lucide-copy',
    'i-lucide-check',
    'i-lucide-git-branch',
    'i-lucide-file',
    'i-lucide-share-2',
    'i-lucide-terminal',
    'i-lucide-package',
    'i-lucide-download',
    'i-lucide-link',
    'i-lucide-x',
    'i-lucide-folder',
    'i-lucide-code',
    'i-lucide-settings',
    'i-lucide-wifi',
    'i-lucide-globe',
    'i-lucide-zap',
    'i-lucide-shield',
    'i-lucide-hard-drive',
    'i-lucide-pencil',
  ],
  presets: [
    presetUno(),
    presetIcons({
      scale: 1.2,
      extraProperties: {
        'display': 'inline-block',
        'vertical-align': 'middle',
      },
    }),
  ],
  theme: {
    colors: {
      surface: {
        0: '#0f0f0f',
        1: '#181818',
        2: '#232323',
        3: '#3f3f3f',
      },
      text: {
        1: '#ffffff',
        2: '#aaaaaa',
        3: '#606060',
      },
      accent: '#916dfe',
      success: '#2ba640',
      danger: '#ff0000',
    },
  },
  shortcuts: {
    'flex-center': 'flex items-center justify-center',
    'btn': 'px-4 py-2 rounded-lg text-sm font-medium transition-colors duration-100 select-none disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer',
    'btn-primary': 'btn bg-accent text-white hover:bg-accent/80',
    'btn-ghost': 'btn bg-surface-2 text-text-1 hover:bg-surface-3',
  },
  preflights: [
    {
      getCSS: () => `
        button {
          border: none;
          background: transparent;
          cursor: pointer;
          font: inherit;
          color: inherit;
        }
      `,
    },
  ],
});
