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
        0: 'rgb(var(--surface-0) / <alpha-value>)',
        1: 'rgb(var(--surface-1) / <alpha-value>)',
        2: 'rgb(var(--surface-2) / <alpha-value>)',
        3: 'rgb(var(--surface-3) / <alpha-value>)',
      },
      text: {
        1: 'rgb(var(--text-1) / <alpha-value>)',
        2: 'rgb(var(--text-2) / <alpha-value>)',
        3: 'rgb(var(--text-3) / <alpha-value>)',
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
