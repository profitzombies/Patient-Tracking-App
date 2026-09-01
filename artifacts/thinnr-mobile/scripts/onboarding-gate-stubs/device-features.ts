export function useDeviceFeatures() {
  return {
    notification: 'available',
    biometric: 'available',
    health: 'available',
    message: null,
    busy: false,
    locked: false,
    enableNotifications: async () => true,
    disableNotifications: async () => undefined,
    enableBiometrics: async () => true,
    disableBiometrics: async () => undefined,
    authenticate: async () => true,
    connectAndImportHealth: async () => true,
    openSettings: async () => undefined,
  };
}