/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        panel: "#151821",
        line: "#2a3040",
        ink: "#e7e9ee",
        muted: "#9aa3b2",
        accent: "#2dd4bf",
        warning: "#f59e0b",
        danger: "#ef4444"
      }
    }
  },
  plugins: []
};
