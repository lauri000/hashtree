export interface TreeRootSubscriptionPlan {
  attachWorkerSubscription: boolean;
  useResolverSubscription: boolean;
}

export function shouldStartTreeRootSubscription(options: {
  hasState: boolean;
  hasResolverSubscription: boolean;
  hasWorkerSubscription: boolean;
}): boolean {
  const { hasState, hasResolverSubscription, hasWorkerSubscription } = options;
  return !hasState || (!hasResolverSubscription && !hasWorkerSubscription);
}

export function getTreeRootSubscriptionPlan(options: {
  workerSubscribed: boolean;
  workerHydrated: boolean;
}): TreeRootSubscriptionPlan {
  const { workerSubscribed, workerHydrated } = options;
  return {
    attachWorkerSubscription: workerSubscribed,
    useResolverSubscription: !workerHydrated,
  };
}
