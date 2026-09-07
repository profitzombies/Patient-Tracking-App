/** Node stand-in for expo-constants: the consent screen stamps the app version. */
const Constants = {
  expoConfig: { version: '1.0.0-test' } as { version?: string },
  appOwnership: null as string | null,
  executionEnvironment: 'bare',
  isDevice: false,
};
export default Constants;
