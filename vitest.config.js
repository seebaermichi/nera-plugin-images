import { defineConfig } from 'vitest/config'

// sharp encodes (AVIF especially) take seconds; under the full parallel suite
// they outgrow vitest's 5 s default, which made the pre-push hook flaky.
export default defineConfig({
    test: {
        testTimeout: 30000,
    },
})
