import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPortableSmoke } from './portable-smoke-lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');

runPortableSmoke({
  distDir: path.join(appDir, 'dist-docs'),
  title: 'Iris Docs',
  appName: 'docs',
  screenshotPath: path.join(appDir, 'test-results', 'docs-iris-portable-smoke.png'),
}).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
