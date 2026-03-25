import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const boardViewPath = path.resolve(process.cwd(), 'src/components/Boards/BoardView.svelte');
const boardViewSource = fs.readFileSync(boardViewPath, 'utf8');

describe('boards hydration effect markup', () => {
  it('reads loading-state inputs without tracking board hydration writes', () => {
    expect(boardViewSource).toContain('untrack(() => hydratedRouteKey)');
    expect(boardViewSource).toContain('untrack(() => !!board)');
    expect(boardViewSource).not.toContain('shouldShowBoardLoading(hydratedRouteKey, routeKey, !!board)');
  });
});
