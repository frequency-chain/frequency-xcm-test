import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Mainnet Chopsticks forks can take several minutes on first sync
    testTimeout: 600000,
    silent: false,
    hookTimeout: 600000,
    teardownTimeout: 60000,
    globals: true,
    environment: 'node',
  },
});
