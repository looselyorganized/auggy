import reactHooks from "eslint-plugin-react-hooks";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";

export default [
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}", "server.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
