import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0a0a',
        surface: '#141414',
        border: '#1e1e1e',
        text: {
          primary: '#e5e5e5',
          secondary: '#737373',
        },
        kept: '#22c55e',
        reverted: '#ef4444',
        uncertain: '#eab308',
        running: '#3b82f6',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-jetbrains)', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
}

export default config
