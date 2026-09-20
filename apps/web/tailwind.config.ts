import type { Config } from 'tailwindcss';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const preset = require('@ouvion/ui/tailwind-preset');

const config: Config = {
  presets: [preset],
  content: ['./src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  plugins: [],
};

export default config;
