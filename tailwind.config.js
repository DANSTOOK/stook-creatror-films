/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Filmora-style dark editing surface.
        panel: {
          950: '#0d0f14',
          900: '#131722',
          800: '#1a1f2e',
          700: '#232a3d',
          600: '#2e364d',
        },
        accent: {
          DEFAULT: '#3b82f6',
          hover: '#60a5fa',
        },
        track: {
          video: '#2b4c7e',
          audio: '#2f6f5b',
          text: '#7a4c86',
          adjustment: '#8a6a2f',
        },
      },
      fontSize: {
        '2xs': ['0.65rem', '0.85rem'],
      },
    },
  },
  plugins: [],
};
