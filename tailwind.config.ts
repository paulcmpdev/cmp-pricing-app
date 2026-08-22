import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        cmp: {
          cyan: "#2AC0DB",
          "cyan-dark": "#1EA8C0",
          "cyan-light": "#E8F8FB",
          gray: "#8B8E90",
          "gray-light": "#D1D3D4",
          charcoal: "#231F20",
          surface: "#F5F5F5",
        },
      },
      fontFamily: {
        display: [
          "Eurostile",
          "Eurostile Extended",
          "Barlow Semi Condensed",
          "Arial Narrow",
          "sans-serif",
        ],
        body: ["DIN", "DIN 2014", "Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
export default config;
