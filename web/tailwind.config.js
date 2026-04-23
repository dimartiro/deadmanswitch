/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Surface stack — near-black with faint cyan undertone.
        canvas: "#07090B",
        paper: "#0E1114",
        muted: "#14181D",
        mist: "#1C2127",
        hairline: "#202731",
        rule: "#2A3340",

        // Ink — cool off-white stack for terminal text.
        ink: {
          DEFAULT: "#E6EDF5",
          900: "#E6EDF5",
          700: "#B0BBC8",
          500: "#727C8A",
          400: "#4E5763",
          300: "#323B47",
          200: "#1F2632",
        },

        // Primary neon — aqua-green. The "live/OK" accent.
        neon: {
          50: "#0F2A23",
          100: "#16463B",
          200: "#1D6654",
          300: "#229077",
          400: "#2CC999",
          500: "#00FFB3",
          600: "#7CFFD4",
          700: "#BFFFE9",
        },

        // Secondary neon — hot magenta/rose. The "mark/alert" accent.
        fuchsia: {
          50: "#2A0A1C",
          100: "#42102D",
          200: "#6B1848",
          300: "#A02168",
          400: "#E3338E",
          500: "#FF2E93",
          600: "#FF7AB6",
          700: "#FFC6DD",
        },

        // Tertiary — amber for warnings / brass markers.
        amber: {
          50: "#261A07",
          100: "#3A2810",
          200: "#60401B",
          300: "#8F5F23",
          400: "#C9882B",
          500: "#FFBE0B",
          600: "#FFD560",
          700: "#FFEBB0",
        },

        // Semantic
        positive: "#00FFB3",
        caution: "#FFBE0B",
        danger: "#FF3860",
      },
      fontFamily: {
        display: ['"Oxanium"', '"Space Grotesk"', 'system-ui', 'sans-serif'],
        sans: [
          '"JetBrains Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
        mono: [
          '"JetBrains Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
        grotesk: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        none: "0",
        sm: "2px",
        DEFAULT: "3px",
        md: "4px",
        lg: "6px",
        xl: "8px",
        "2xl": "10px",
        "3xl": "14px",
      },
      boxShadow: {
        soft: "0 0 0 1px rgba(0, 255, 179, 0.04)",
        card: "0 0 0 1px rgba(0, 255, 179, 0.04), 0 8px 24px rgba(0, 0, 0, 0.5)",
        lifted:
          "0 0 0 1px rgba(0, 255, 179, 0.08), 0 12px 40px rgba(0, 0, 0, 0.6)",
        neon: "0 0 16px rgba(0, 255, 179, 0.25), 0 0 40px rgba(0, 255, 179, 0.08)",
        "neon-fuchsia":
          "0 0 16px rgba(255, 46, 147, 0.3), 0 0 40px rgba(255, 46, 147, 0.1)",
        "focus-ring":
          "0 0 0 3px rgba(0, 255, 179, 0.18), 0 0 0 1px rgba(0, 255, 179, 0.7)",
      },
      animation: {
        "fade-in": "fadeIn 0.3s ease-out forwards",
        "slide-up": "slideUp 0.35s cubic-bezier(0.2, 0.8, 0.2, 1) forwards",
        "cursor-blink": "blink 1s step-end infinite",
        scan: "scan 6s linear infinite",
        "neon-pulse": "neonPulse 2.5s ease-in-out infinite",
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
        blink: {
          "0%, 50%": { opacity: "1" },
          "51%, 100%": { opacity: "0" },
        },
        scan: {
          "0%": { backgroundPosition: "0 0" },
          "100%": { backgroundPosition: "0 -200px" },
        },
        neonPulse: {
          "0%, 100%": {
            boxShadow:
              "0 0 16px rgba(0, 255, 179, 0.25), 0 0 40px rgba(0, 255, 179, 0.08)",
          },
          "50%": {
            boxShadow:
              "0 0 24px rgba(0, 255, 179, 0.4), 0 0 60px rgba(0, 255, 179, 0.15)",
          },
        },
      },
    },
  },
  plugins: [],
};
