import { NativeModules, PermissionsAndroid, Platform } from 'react-native'

let startupPermissionsRequested = false

export async function requestStartupPermissions(): Promise<void> {
  if (Platform.OS !== 'android' || startupPermissionsRequested) return
  // Один запрос за запуск: возврат из системного диалога не должен открывать его снова.
  startupPermissionsRequested = true

  if (Number(Platform.Version) < 29) {
    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE)
  }
  if (Number(Platform.Version) >= 33) {
    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)
  }

  // MediaStore на Android 10+ сохраняет наши файлы без доступа ко всему хранилищу.
  const backgroundModule = NativeModules.RNBackgroundActions
  if (typeof backgroundModule?.isIgnoringBatteryOptimizations !== 'function'
    || typeof backgroundModule?.requestBatteryOptimizationExemption !== 'function') return

  if (!await backgroundModule.isIgnoringBatteryOptimizations()) {
    await backgroundModule.requestBatteryOptimizationExemption()
  }
}
