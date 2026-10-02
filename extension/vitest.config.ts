import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    // English is the primary catalog; pin it so assertions don't depend on the host language
    setupFiles: ['./tests/setup.ts'],
  },
});
