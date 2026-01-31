import { defineConfig, presetUno, presetIcons } from 'unocss';

export default defineConfig({
  safelist: [
    'i-lucide-chevron-left',
    'i-lucide-chevron-right',
    'i-lucide-home',
    'i-lucide-settings',
    'i-lucide-search',
    'i-lucide-loader-2',
    'i-lucide-refresh-cw',
    'i-lucide-star',
    'i-lucide-clock',
    'i-lucide-x',
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
        1: '#212121',
        2: '#272727',
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
      warning: '#ffcc00',
    },
    borderRadius: {
      DEFAULT: '6px',
      sm: '4px',
      lg: '8px',
    },
  },
  shortcuts: {
    'btn': 'px-3 py-1.5 min-h-9 rounded-full text-sm font-medium transition-colors duration-100 select-none disabled:opacity-50 disabled:cursor-not-allowed',
    'btn-ghost': 'btn bg-surface-2 text-text-1 hover:bg-surface-3 disabled:hover:bg-surface-2',
    'btn-circle': 'w-9 min-h-9 p-0! rounded-full flex items-center justify-center transition-colors duration-100 select-none disabled:opacity-50 disabled:cursor-not-allowed',
    'input': 'px-3 py-1.5 bg-surface-0 b-1 b-solid b-surface-3 rounded-full text-text-1 outline-none focus:b-accent',
    'text-muted': 'text-text-2',
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
