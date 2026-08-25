/**
 * Node stand-in for react-native used by the provider-training suite (see
 * tsconfig.provider-training.json `paths`). Re-exports the onboarding-hints
 * stub and adds the pieces the training screens touch on top of it.
 */
export * from '../onboarding-hints-stubs/react-native';

/** Host passthrough — react-test-renderer treats string types as hosts. */
export const ActivityIndicator = 'ActivityIndicator';
