/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Filmora-style dark editing surface.
        // The surfaces and the text greys are the theme's (theme/palette.css):
        // dark by default, light when chosen. Written as channels so an
        // opacity still works: bg-panel-900/60.
        panel: {
          950: 'rgb(var(--panel-950) / <alpha-value>)',
          900: 'rgb(var(--panel-900) / <alpha-value>)',
          800: 'rgb(var(--panel-800) / <alpha-value>)',
          700: 'rgb(var(--panel-700) / <alpha-value>)',
          600: 'rgb(var(--panel-600) / <alpha-value>)',
        },
        slate: Object.fromEntries([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((step) => [step, `rgb(var(--slate-${step}) / <alpha-value>)`])),
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
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          strong: 'rgb(var(--accent-strong) / <alpha-value>)',
          hover: 'rgb(var(--accent-hover) / <alpha-value>)',
          // What is written on a fill of the accent: dark on the cyan, white on the others.
          contrast: 'rgb(var(--accent-contrast) / <alpha-value>)',
        },
        // The Effects panel's two families (MediaLibrary/EffectsBrowser): a
        // shade of each that reads as text on the panels in either theme.
        family: {
          camera: 'rgb(var(--fx-camera) / <alpha-value>)',
          look: 'rgb(var(--fx-look) / <alpha-value>)',
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
        The type scale, compact as CapCut's: 12px is the body. Four sizes:
          11 labels, 12 controls, panel titles and body, 14 dialog titles,
          18 the start screen.
        The Tailwind names the code already used are pointed at the same four,
        so every existing class lands on the scale, and the semantic names say
        what a size is for. Titles stand out by weight, not by size.
      */
      fontSize: {
        '2xs': ['11px', '15px'],
        xs: ['12px', '16px'],
        sm: ['12px', '17px'],
        base: ['14px', '19px'],
        lg: ['18px', '24px'],
        label: ['11px', '15px'],
        control: ['12px', '16px'],
        body: ['12px', '17px'],
        title: ['14px', '19px'],
        display: ['18px', '24px'],
      },
      /*
        Three radii, round as CapCut's: 6 for controls, 8 for menus and
        cards, 12 for panels and dialogs. rounded-xl is folded into 12 so
        nothing is rounder than a panel.
      */
      borderRadius: {
        DEFAULT: '6px',
        md: '8px',
        lg: '12px',
        xl: '12px',
        control: '6px',
        menu: '8px',
        panel: '12px',
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
