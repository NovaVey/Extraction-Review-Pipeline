// @testing-library/jest-dom's own bundled `declare module 'vitest'` augmentation
// (its "/vitest" export) does its own internal `import 'vitest'` FROM WHERE THAT
// PACKAGE PHYSICALLY LIVES -- hoisted to the monorepo root, since /api's own older
// vitest devDependency already occupies root node_modules/vitest, so it resolves a
// DIFFERENT `vitest` module (root's) than this workspace's test files do (this
// workspace's own, nested web/node_modules/vitest). TypeScript's declaration
// merging for `declare module 'vitest'` is keyed to that resolution, so jest-dom's
// bundled augmentation doesn't reach the `expect(...)` this workspace's tests
// actually call. Declaring it again here, in a file that lives under web/src/ (so
// ITS OWN `import 'vitest'` resolves to the same package this workspace uses),
// sidesteps the mismatch. Runtime matcher registration is separate (see
// setupTests.ts) -- this file exists purely for the TypeScript types.
//
// Extend with more signatures here as tests come to use more jest-dom matchers.
import 'vitest';

declare module 'vitest' {
  interface Assertion<T = unknown> {
    toBeInTheDocument(): T;
    toBeDisabled(): T;
  }
}
