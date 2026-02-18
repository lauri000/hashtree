export interface InactivityTimer {
  clear(): void;
  touch(): void;
}

export function createInactivityTimer(timeoutMs: number, onTimeout: () => void): InactivityTimer {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let active = true;

  const arm = (): void => {
    if (!active) return;
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      if (!active) return;
      active = false;
      timeoutId = null;
      onTimeout();
    }, timeoutMs);
  };

  arm();

  return {
    clear(): void {
      active = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    },
    touch(): void {
      arm();
    },
  };
}
