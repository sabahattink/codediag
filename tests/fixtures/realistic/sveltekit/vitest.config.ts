import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
	viteConfig,
	defineConfig({
		test: {
			include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
			coverage: { provider: 'v8', thresholds: { lines: 80, branches: 70 } }
		}
	})
);
