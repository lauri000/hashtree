export type RuntimeUpdateAction = 'bootstrap' | 'ignore' | 'notify' | 'reload';

export function classifyRuntimeUpdate(
  currentSignature: string,
  nextSignature: string,
  autoReloadEnabled: boolean,
): RuntimeUpdateAction {
  if (!currentSignature) {
    return 'bootstrap';
  }

  if (nextSignature === currentSignature) {
    return 'ignore';
  }

  return autoReloadEnabled ? 'reload' : 'notify';
}
