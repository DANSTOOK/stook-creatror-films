/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Filmora-style dark editing surface.
        panel: {
          950: '#0e0f11',
          900: '#16181c',
          800: '#1d2025',
          700: '#272a31',
          600: '#343840',
        },
        accent: {
          DEFAULT: '#3b82f6',
          hover: '#60a5fa',
        },
        track: {
          video: '#456698',
          audio: '#33785f',
          text: '#82548e',
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
