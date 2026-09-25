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
        /*
          The accent. DEFAULT fills the things that act - the primary button,
          a progress bar, a checked box - and white on it reads at 5.17:1;
          the old #3b82f6 gave white text only 3.68:1. `strong` is the same
          blue pressed darker, for a filled button under the pointer (white on
          it 6.70:1): lighter would lose the text. `hover` is the light blue
          used AS text and icons on the dark panels (5.8:1 on panel-900); the
          name is historical.
        */
        accent: {
          DEFAULT: '#2563eb',
          strong: '#1d4ed8',
          hover: '#60a5fa',
        },
        // A finished job, and only that: the blue accent stays "act here",
        // mint says "done". 12.2:1 on panel-950 and 11.3:1 on panel-900;
        // panel-950 text on it reads at 12.2:1 (15.4:1 on the hover).
        success: {
          DEFAULT: '#1de9b6',
          hover: '#64ffda',
        },
        track: {
          video: '#456698',
          audio: '#33785f',
          text: '#82548e',
          adjustment: '#8a6a2f',
        },
      },
      /*
        Segoe UI Variable, the Windows 11 system face, with no web font: the
        app runs offline. Chromium resolves its named instance "Segoe UI
        Variable Text" (the bare family name does not match here); Windows 10
        falls back to Segoe UI, anything else to the system face.
      */
      fontFamily: {
        sans: ['"Segoe UI Variable Text"', '"Segoe UI Variable"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        display: ['"Segoe UI Variable Display"', '"Segoe UI Variable"', '"Segoe UI"', 'system-ui', 'sans-serif'],
      },
      /*
        The type scale. Five sizes and no others:
          11 labels, 12 controls, 13 panel titles and body, 15 dialog titles,
          20 the start screen.
        The Tailwind names the code already used are pointed at the same five,
        so every existing class lands on the scale (text-2xs was 10.4px, which
        was on no scale at all), and the semantic names say what a size is for.
      */
      fontSize: {
        '2xs': ['11px', '15px'],
        xs: ['12px', '16px'],
        sm: ['13px', '18px'],
        base: ['15px', '20px'],
        lg: ['20px', '26px'],
        label: ['11px', '15px'],
        control: ['12px', '16px'],
        body: ['13px', '18px'],
        title: ['15px', '20px'],
        display: ['20px', '26px'],
      },
      /*
        Three radii: 4 for controls, 6 for menus and cards, 8 for panels and
        dialogs. rounded-xl (12px) is folded into 8 so nothing is rounder than
        a panel.
      */
      borderRadius: {
        DEFAULT: '4px',
        md: '6px',
        lg: '8px',
        xl: '8px',
        control: '4px',
        menu: '6px',
        panel: '8px',
      },
      /* Two control heights - 24 dense, 28 default - and 32 for the one primary action. */
      height: {
        'control-dense': '24px',
        control: '28px',
        'control-primary': '32px',
      },
      minHeight: {
        'control-dense': '24px',
        control: '28px',
        'control-primary': '32px',
      },
    },
  },
  plugins: [],
};
