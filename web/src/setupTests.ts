import { afterEach, expect } from 'vitest';
import { cleanup } from '@testing-library/react';
// The framework-specific `@testing-library/jest-dom/vitest` entry point does its
// own `import { expect } from 'vitest'` internally -- in this npm-workspaces repo,
// that resolves to the ROOT node_modules' vitest (hoisted from /api's own, older
// vitest devDependency), not this workspace's, since @testing-library/jest-dom
// itself is hoisted to the root. That extends a different `expect` instance than
// the one this workspace's tests actually import, so the matchers silently never
// applied. Importing the framework-agnostic matcher object instead and extending
// THIS file's own `expect` (imported directly above, resolving correctly within
// web/node_modules) sidesteps the cross-workspace resolution mismatch entirely.
import * as jestDomMatchers from '@testing-library/jest-dom/matchers';
// The TypeScript side of this (declaring toBeInTheDocument/toBeDisabled etc. on
// `expect(...)`'s return type) lives in vitest-jest-dom.d.ts, for the same
// cross-workspace resolution reason as the comment above.

expect.extend(jestDomMatchers);

// Not using vitest's `globals: true` (this repo's test files always explicitly
// import from 'vitest', matching the api workspace's convention), so
// @testing-library/react's own auto-cleanup (which relies on detecting a global
// afterEach) doesn't kick in on its own — without this, each test's rendered <App>
// would keep accumulating in the jsdom document, and later tests' queries would
// start matching leftover elements from earlier ones.
afterEach(() => {
  cleanup();
});
