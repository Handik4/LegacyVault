import type { Config } from "tailwindcss";

// Light-mode private-banking palette: warm alabaster ground, slate ink,
// forest-emerald = healthy / alive, amber = veto countdown, crimson = slash.
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        alabaster: { DEFAULT: "#faf8f3", deep: "#f3efe6" },
        ink: "#0f172a",
        forest: { 50: "#ecf6f0", 100: "#d3ebdc", 600: "#1f7a52", 700: "#17633f", 800: "#124f33" },
        veto: { 50: "#fdf6e7", 100: "#fbe9bd", 600: "#b9770e", 700: "#935c07" },
        crimson: { 50: "#fdeeee", 100: "#f8d4d4", 600: "#b42318", 700: "#8f1b12" },
      },
      fontFamily: {
        serif: ["Georgia", "'Iowan Old Style'", "'Palatino Linotype'", "serif"],
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "'Segoe UI'", "Helvetica", "Arial", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      boxShadow: { card: "0 1px 0 rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.12)" },
    },
  },
  plugins: [],
};
export default config;
