import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  extends: [core, react, vitest],
  rules: {
    // Autofixes for these change behavior or break types (key order matters
    // for URLs/env/detection priority; stripping `undefined` args breaks calls).
    "eslint/sort-keys": "off",
    "unicorn/no-useless-undefined": "off",
    "vitest/prefer-import-in-mock": "off",
    // Style rules that don't fit this codebase's conventions.
    "eslint/no-void": "off",
    "eslint/no-plusplus": "off",
    "eslint/no-await-in-loop": "off",
    "eslint/no-use-before-define": "off",
    "eslint/complexity": "off",
    "eslint/class-methods-use-this": "off",
    "eslint/max-classes-per-file": "off",
    "promise/prefer-await-to-then": "off",
    "promise/prefer-await-to-callbacks": "off",
    "promise/avoid-new": "off",
    "typescript/parameter-properties": "off",
    "unicorn/filename-case": "off",
    // Cards are focusable regions with their own shortcut keys; datalist options have no visible label.
    "jsx-a11y/no-noninteractive-tabindex": "off",
    "jsx-a11y/no-noninteractive-element-interactions": "off",
    "jsx-a11y/control-has-associated-label": "off",
    // Extra effect dependencies are deliberate re-run triggers; the latest-ref pattern assigns refs during render.
    "react/exhaustive-effect-dependencies": "off",
    "react/refs": "off",
    // then(a, b) deliberately keeps b from catching errors thrown by a.
    "promise/prefer-catch": "off",
    "eslint/no-bitwise": "off",
    "eslint/no-control-regex": "off",
    "node/callback-return": "off",
    "react/state-in-constructor": "off",
    "unicorn/prefer-code-point": "off",
    "unicorn/no-document-cookie": "off",
    "unicorn/prefer-add-event-listener": "off",
    "import/no-cycle": "off",
    "react/jsx-pascal-case": "off",
    "react/hook-use-state": "off",
    "eslint/no-param-reassign": "off",
    "eslint/no-loop-func": "off",
    "react/purity": "off",
    "react/jsx-no-constructed-context-values": "off",
    "unicorn/prefer-export-from": "off",
    "unicorn/prefer-query-selector": "off",
    "unicorn/require-post-message-target-origin": "off",
    "eslint/no-template-curly-in-string": "off",
    "typescript/no-dynamic-delete": "off",
    "react/function-component-definition": "off",
    "unicorn/prefer-ternary": "off",
    "eslint/no-inline-comments": "off",
    "react/todo": "off",
    "unicorn/consistent-function-scoping": "off",
    "jsx-a11y/prefer-tag-over-role": "off",
    "eslint/no-alert": "off",
    "react/set-state-in-effect": "off",
    // Wants `error` for every catch/.catch parameter, which no-shadow forbids next to an `error` state.
    "unicorn/catch-error-name": "off",
  },
  overrides: [
    {
      // Waku calls getConfig() and renders pages as async by convention, whether or not they await.
      files: ["apps/docs/src/pages/**"],
      rules: { "eslint/require-await": "off" },
    },
  ],
  ignorePatterns: [
    "**/test/**",
    "**/*.test.ts",
    "**/*.test.tsx",
    "**/*.e2e.ts",
  ],
});
