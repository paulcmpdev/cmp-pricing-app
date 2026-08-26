import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  ...nextVitals,
  {
    rules: {
      // Existing components intentionally trigger async recalculation or UI state
      // from effects. Refactoring those pricing flows is outside this auth release.
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    files: ["tests/**/*.{ts,tsx}", "app/**/__tests__/**/*.{ts,tsx}", "lib/**/__tests__/**/*.{ts,tsx}"],
    rules: {
      // Playwright fixture callbacks conventionally name their continuation `use`.
      "react-hooks/rules-of-hooks": "off",
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "playwright-report/**",
    "test-results/**",
    "scripts/lib/vendor-sources/**/*.d.mts",
    "next-env.d.ts",
  ]),
]);
