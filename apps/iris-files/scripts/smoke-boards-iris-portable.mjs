import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPortableSmoke } from './portable-smoke-lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');

runPortableSmoke({
  distDir: path.join(appDir, 'dist-boards'),
  title: 'Iris Boards',
  appName: 'boards',
  screenshotPath: path.join(appDir, 'test-results', 'boards-iris-portable-smoke.png'),
}).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
