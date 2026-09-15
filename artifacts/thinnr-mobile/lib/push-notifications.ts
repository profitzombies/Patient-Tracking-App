import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import {
  getOrCreateDeviceId,
  pushAvailability,
  type PushRegistrationDriver,
} from './push-notification-core';
import {
  registerPushDevice,
  registerStaffPushDevice,
  unregisterPushDevice,
  unregisterStaffPushDevice,
} from './push-notifications-api';

export const pushProjectId =
  Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? null;
export const expoGo =
  Constants.appOwnership === 'expo' || Constants.executionEnvironment === 'storeClient';
export const currentPushAvailability = pushAvailability({
  platform: Platform.OS,
  expoGo,
  isDevice: Constants.isDevice !== false,
  projectId: pushProjectId,
});

export const pushDeviceIdStore = {
  get: (key: string) => SecureStore.getItemAsync(key),
  set: (key: string, value: string) => SecureStore.setItemAsync(key, value),
};

export const pushRegistrationDriver: PushRegistrationDriver = {
  async permission() {
    const result = await Notifications.getPermissionsAsync();
    return result.granted ? 'granted' : result.status === 'denied' ? 'denied' : 'undetermined';
  },
  async requestPermission() {
    const result = await Notifications.requestPermissionsAsync();
    return result.granted ? 'granted' : 'denied';
  },
  async getToken(projectId) {
    return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  },
  register: registerPushDevice,
  unregister: unregisterPushDevice,
};

export const staffPushRegistrationDriver: PushRegistrationDriver = {
  ...pushRegistrationDriver,
  register: registerStaffPushDevice,
  unregister: unregisterStaffPushDevice,
};

export function pushRegistrationDriverWithToken(
  accessToken: string,
  staff: boolean,
): PushRegistrationDriver {
  const base = staff ? staffPushRegistrationDriver : pushRegistrationDriver;
  return {
    ...base,
    register: payload => staff
      ? registerStaffPushDevice(payload, accessToken)
      : registerPushDevice(payload, accessToken),
    unregister: payload => staff
      ? unregisterStaffPushDevice(payload, accessToken)
      : unregisterPushDevice(payload, accessToken),
  };
}

export function currentPushDeviceId() {
  return getOrCreateDeviceId(pushDeviceIdStore);
}