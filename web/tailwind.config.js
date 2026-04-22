/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Surface scale — warm dark, slightly green-black undertone.
        canvas: "#0D0E0B",   // app background
        paper: "#16171A",    // cards (a touch cooler than bg to lift)
        muted: "#1E1F1C",    // secondary surfaces / nested
        mist: "#26282A",     // hover / deeper surfaces
        hairline: "#2A2C2F", // default border
        rule: "#3A3C3F",     // stronger dividers

        // Ink scale — inverted: primary text is warm off-white.
        ink: {
          DEFAULT: "#F2EFE6",
          900: "#F2EFE6",
          700: "#C9C5BA",
          500: "#8F8C82",
          400: "#6B6964",
          300: "#4E4C48",
          200: "#38372F",
        },

        // Primary accent — forest/pine, pushed brighter for dark mode.
        estate: {
          50: "#16221A",
          100: "#1D3021",
          200: "#2A4A30",
          300: "#3D6A45",
          400: "#5E9267",
          500: "#7BAB85",
          600: "#9FC4A8",
          700: "#BEDCC5",
          800: "#D9EBDD",
          900: "#EEF6F0",
        },

        // Secondary accent — warm amber / brass, brighter on dark.
        brass: {
          50: "#231809",
          100: "#3A2A10",
          200: "#5C431B",
          300: "#8A6324",
          400: "#C89724",
          500: "#E4B84A",
          600: "#F2D684",
          700: "#F9EBC2",
        },

        // Semantic states — tuned for dark backgrounds.
        positive: "#4FAE6E",
        caution: "#E8A23B",
        danger: "#E07266",
      },
      fontFamily: {
        display: ['"Fraunces"', 'Georgia', 'serif'],
        sans: [
          '"Plus Jakarta Sans"',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'sans-serif',
        ],
        mono: [
          '"JetBrains Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
      },
      borderRadius: {
        xl: "0.875rem",
        "2xl": "1.125rem",
        "3xl": "1.5rem",
      },
      boxShadow: {
        soft: "0 1px 2px rgba(0, 0, 0, 0.25), 0 1px 3px rgba(0, 0, 0, 0.2)",
        card: "0 2px 4px rgba(0, 0, 0, 0.3), 0 8px 20px rgba(0, 0, 0, 0.25)",
        lifted:
          "0 4px 10px rgba(0, 0, 0, 0.3), 0 16px 32px rgba(0, 0, 0, 0.35)",
        "focus-ring":
          "0 0 0 4px rgba(94, 146, 103, 0.18), 0 0 0 1px rgba(123, 171, 133, 0.6)",
      },
      animation: {
        "fade-in": "fadeIn 0.3s ease-out forwards",
        "slide-up": "slideUp 0.35s cubic-bezier(0.2, 0.8, 0.2, 1) forwards",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
