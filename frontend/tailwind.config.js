/** @type {import('tailwindcss').Config} */
/*
 * StudyMate theme: "ink and highlighter".
 * - accent: ink blue, for actions, links, the active nav item and focus.
 * - mark:   highlighter yellow, only where the app points at evidence (source passages, selections).
 * - n:      cool slate neutrals; 100-300 surfaces, 400-500 borders and quiet marks, 600-900 text.
 * Token names are unchanged, so every page picks the theme up without edits.
 */
module.exports = {
  content: ['./src/**/*.{js,jsx}', './public/index.html'],
  theme: {
    extend: {
      colors: {
        bg: '#f6f7f8',
        surface: '#ffffff',
        ink: '#172031',
        divider: 'rgba(23,32,49,0.12)',
        accent: {
          DEFAULT: '#3056c2',
          100: '#eef2fc', 200: '#d9e2f8', 300: '#b4c5f0', 400: '#7f9be2',
          500: '#4a6fd0', 600: '#2747a8', 700: '#1f3a8a', 800: '#1a306f', 900: '#142553',
        },
        mark: { DEFAULT: '#ffe066', soft: '#fff4c2', ink: '#5c4a00' },
        n: {
          100: '#eef0f3', 200: '#e3e6eb', 300: '#cdd2da', 400: '#a9b0bc',
          500: '#6b7383', 600: '#596171', 700: '#454c59', 800: '#2e3440', 900: '#1d222b',
        },
        good: '#157a55',
        warn: '#a86b12',
        bad: '#c0392b',
      },
      fontFamily: {
        heading: ['"Hanken Grotesk"', 'system-ui', 'sans-serif'],
        body: ['"Hanken Grotesk"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: { sm: '4px', md: '8px', lg: '12px' },
      boxShadow: {
        sm: '0 1px 2px rgba(23,32,49,0.05), 0 1px 1px rgba(23,32,49,0.04)',
      },
    },
  },
  plugins: [],
};
