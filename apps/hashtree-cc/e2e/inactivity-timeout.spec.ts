import { expect, test } from '@playwright/test';
import { createInactivityTimer } from '../src/lib/inactivityTimeout';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('inactivity timer stays alive while touched', async () => {
  let timedOut = false;
  const timer = createInactivityTimer(40, () => {
    timedOut = true;
  });

  await sleep(20);
  timer.touch();
  await sleep(20);
  timer.touch();
  await sleep(20);

  expect(timedOut).toBe(false);
  timer.clear();
});

test('inactivity timer fires once after inactivity', async () => {
  let timeoutCount = 0;
  const timer = createInactivityTimer(30, () => {
    timeoutCount += 1;
  });

  await sleep(80);
  expect(timeoutCount).toBe(1);

  timer.touch();
  await sleep(50);
  expect(timeoutCount).toBe(1);

  timer.clear();
});
