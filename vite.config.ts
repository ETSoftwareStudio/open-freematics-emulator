import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.repos/**"],
  },
  fmt: {
    printWidth: 100,
    // release-please writes CHANGELOG.md in its own style on every release PR.
    ignorePatterns: [".repos/**", "**/dist/**", "pnpm-lock.yaml", "patches/**", "CHANGELOG.md"],
  },
  lint: {
    ignorePatterns: [".repos/**", "**/dist/**", "node_modules", "**/routeTree.gen.ts"],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: ["./oxlint-plugin-fme/index.ts"],
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "oxc/no-accumulating-spread": "error",
      "eslint/no-control-regex": "off",
      "unicorn/prefer-add-event-listener": "off",
      "unicorn/prefer-string-starts-ends-with": "off",
      "unicorn/prefer-set-has": "off",
      "unicorn/no-new-array": "off",
      "unicorn/no-array-sort": "off",
      "unicorn/consistent-function-scoping": "off",
      "react/memo-dependencies": "error",
      "react/purity": "error",
      "react/refs": "error",
      "react/exhaustive-effect-dependencies": "error",
      "react/set-state-in-effect": "error",
      "react/immutability": "error",
      "react/no-array-index-key": "error",
      "react/no-unstable-nested-components": "error",
      "react/static-components": "error",
      "react-in-jsx-scope": "off",
      "react/jsx-no-constructed-context-values": "off",
      "react-hooks/exhaustive-deps": "off",
      "typescript/no-extraneous-class": "error",
      "eslint/no-empty-pattern": "error",
      "eslint/no-new": "error",
      "unicorn/no-useless-spread": "error",
      "eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "eslint/no-unsafe-optional-chaining": "error",
      "eslint/no-unneeded-ternary": "error",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
      "eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "effect",
              message:
                'Import Effect modules as namespaces from subpaths: import * as Effect from "effect/Effect".',
            },
          ],
        },
      ],
      "fme/namespace-node-imports": "error",
      "fme/no-inline-schema-compile": "error",
      "fme/no-low-value-comments": "error",
      "fme/no-manual-effect-runtime-in-tests": "error",
      "fme/no-polling-loop-in-tests": "error",
      "fme/no-real-time-wait-in-tests": "error",
      "fme/no-test-in-loop": "error",
      "fme/no-test-timeout-or-unreasoned-skip": "error",
      "fme/no-unreasoned-state-sync": "error",
      "fme/no-wall-clock-in-tests": "error",
      "fme/prefer-catch-tags": "error",
      "fme/prefer-effect-fn": "error",
      "fme/require-suppression-reason": "error",
    },
    overrides: [
      {
        files: ["**/*.{test,spec}.{ts,tsx}", "**/{test,tests,testing,fixtures}/**"],
        rules: { "fme/prefer-effect-fn": "off" },
      },
      {
        // The rule tests embed violating fixtures as strings and comments.
        files: ["oxlint-plugin-fme/**"],
        rules: { "fme/no-low-value-comments": "off" },
      },
    ],
  },
});
