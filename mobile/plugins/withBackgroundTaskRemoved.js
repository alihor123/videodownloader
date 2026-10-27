const fs = require('node:fs/promises')
const path = require('node:path')
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins')

function withBackgroundTaskRemoved(config) {
  config = withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest
    const permissions = manifest['uses-permission'] || []
    const permissionNames = new Set(permissions.map((item) => item.$['android:name']))

    for (const name of [
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
      'android.permission.WAKE_LOCK',
      'android.permission.POST_NOTIFICATIONS'
    ]) {
      if (!permissionNames.has(name)) permissions.push({ $: { 'android:name': name } })
    }

    if (!permissions.some((item) => item.$['android:name'] === 'android.permission.WRITE_EXTERNAL_STORAGE')) {
      permissions.push({
        $: {
          'android:name': 'android.permission.WRITE_EXTERNAL_STORAGE',
          'android:maxSdkVersion': '28'
        }
      })
    }

    manifest['uses-permission'] = permissions
    const services = manifest.application[0].service || []
    const backgroundService = services.find((item) => item.$['android:name'] === 'com.asterinet.react.bgactions.RNBackgroundActionsTask')

    const service = backgroundService || {
      $: {
        'android:name': 'com.asterinet.react.bgactions.RNBackgroundActionsTask'
      }
    }

    service.$['android:exported'] = 'false'
    service.$['android:stopWithTask'] = 'false'
    service.$['android:foregroundServiceType'] = 'dataSync'
    if (!backgroundService) services.push(service)
    manifest.application[0].service = services
    return config
  })

  return withDangerousMod(config, ['android', async (config) => {
    const sourceRoot = path.join(config.modRequest.projectRoot, 'node_modules', 'react-native-background-actions', 'android', 'src', 'main', 'java', 'com', 'asterinet', 'react', 'bgactions')
    const modulePath = path.join(sourceRoot, 'BackgroundActionsModule.java')
    const taskPath = path.join(sourceRoot, 'RNBackgroundActionsTask.java')
    let moduleSource = await fs.readFile(modulePath, 'utf8')
    let taskSource = await fs.readFile(taskPath, 'utf8')

    if (!moduleSource.includes('A4_TASK_REMOVED_PATCH')) {
      moduleSource = moduleSource.replace(
        'import com.facebook.react.bridge.ReactContextBaseJavaModule;',
        'import com.facebook.react.bridge.ReactContextBaseJavaModule;\nimport com.facebook.react.bridge.Arguments;\nimport com.facebook.react.modules.core.DeviceEventManagerModule;\nimport java.lang.ref.WeakReference;'
      )
      moduleSource = moduleSource.replace(
        'public class BackgroundActionsModule extends ReactContextBaseJavaModule {',
        'public class BackgroundActionsModule extends ReactContextBaseJavaModule {\n  private static WeakReference<ReactContext> a4Context;\n  public static void emitA4TaskRemoved() {\n    ReactContext context = a4Context == null ? null : a4Context.get();\n    if (context != null && context.hasActiveCatalystInstance()) {\n      context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("a4loaderTaskRemoved", Arguments.createMap());\n    }\n  } // A4_TASK_REMOVED_PATCH'
      )
      moduleSource = moduleSource.replace('this.reactContext = reactContext;', 'this.reactContext = reactContext;\n  a4Context = new WeakReference<>(reactContext);')
    }

    moduleSource = moduleSource.replace('hasActiveCatalystInstance()', 'hasActiveReactInstance()')
    moduleSource = moduleSource.replace(
      'context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("a4loaderTaskRemoved", Arguments.createMap());',
      'context.emitDeviceEvent("a4loaderTaskRemoved", null);'
    )

    if (!taskSource.includes('A4_TASK_REMOVED_PATCH')) {
      taskSource = taskSource.replace(
        'import android.os.Bundle;',
        'import android.os.Bundle;\nimport android.os.Handler;\nimport android.os.Looper;'
      )
      taskSource = taskSource.replace(
        '    @Override\n    public void onTimeout(int startId) {',
        '    @Override\n    public void onTaskRemoved(Intent rootIntent) {\n        BackgroundActionsModule.emitA4TaskRemoved();\n        new Handler(Looper.getMainLooper()).postDelayed(() -> {\n            stopForeground(STOP_FOREGROUND_REMOVE);\n            stopSelf();\n        }, 3000);\n        super.onTaskRemoved(rootIntent);\n    } // A4_TASK_REMOVED_PATCH\n\n    @Override\n    public void onTimeout(int startId) {'
      )
    }

    taskSource = taskSource.replace('}, 3000);', '}, 10000);')

    // После успешной загрузки отвязываем уведомление от жизненного цикла службы.
    if (!moduleSource.includes('A4_COMPLETED_NOTIFICATION_PATCH')) {
      moduleSource = moduleSource.replace(
        'import com.facebook.react.bridge.ReactMethod;',
        'import com.facebook.react.bridge.ReactMethod;\nimport com.facebook.react.bridge.UiThreadUtil;'
      )
      const anchor = '    @SuppressWarnings("unused")\n    @ReactMethod\n    public void start('
      if (!moduleSource.includes(anchor)) throw new Error('BackgroundActionsModule start method was not found')
      moduleSource = moduleSource.replace(anchor, `    @ReactMethod
    public void completeNotification(final String title, final String message, final Promise promise) {
        UiThreadUtil.runOnUiThread(() -> {
            try {
                RNBackgroundActionsTask.completeNotification(title, message);
                promise.resolve(null);
            } catch (Exception error) {
                promise.reject(error);
            }
        });
    } // A4_COMPLETED_NOTIFICATION_PATCH

${anchor}`)
    }

    if (!taskSource.includes('A4_COMPLETED_NOTIFICATION_PATCH')) {
      const anchor = 'final public class RNBackgroundActionsTask extends HeadlessJsTaskService {'
      if (!taskSource.includes(anchor)) throw new Error('RNBackgroundActionsTask class was not found')
      taskSource = taskSource.replace(anchor, `${anchor}
    private static RNBackgroundActionsTask a4ActiveTask;
    private Notification a4Notification;

    public static void completeNotification(String title, String message) {
        final RNBackgroundActionsTask service = a4ActiveTask;
        if (service == null || service.a4Notification == null) {
            throw new IllegalStateException("No active download notification");
        }
        final Notification completed = Notification.Builder.recoverBuilder(service, service.a4Notification)
                .setContentTitle(title)
                .setContentText(message)
                .setOngoing(false)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setProgress(0, 0, false)
                .build();
        service.stopForeground(STOP_FOREGROUND_DETACH);
        service.getSystemService(NotificationManager.class).notify(SERVICE_NOTIFICATION_ID, completed);
    }

    @Override
    public void onDestroy() {
        if (a4ActiveTask == this) a4ActiveTask = null;
        super.onDestroy();
    } // A4_COMPLETED_NOTIFICATION_PATCH
`)
      const notificationAnchor = 'final Notification notification = buildNotification(this, bgOptions);'
      if (!taskSource.includes(notificationAnchor)) throw new Error('Background notification creation was not found')
      taskSource = taskSource.replace(notificationAnchor, `${notificationAnchor}
        a4ActiveTask = this;
        a4Notification = notification;`)
    }

    if (!moduleSource.includes('public void completeNotification(')
      || !taskSource.includes('stopForeground(STOP_FOREGROUND_DETACH)')
      || !taskSource.includes('a4Notification = notification;')) {
      throw new Error('Could not patch completed download notification')
    }

    if (!moduleSource.includes('A4_TASK_REMOVED_PATCH') || !taskSource.includes('A4_TASK_REMOVED_PATCH')) {
      throw new Error('Could not patch react-native-background-actions 4.1.0 task-removed hook')
    }

    if (!moduleSource.includes('hasActiveReactInstance()') || !moduleSource.includes('context.emitDeviceEvent("a4loaderTaskRemoved", null);') || !taskSource.includes('onTaskRemoved(Intent rootIntent)')) {
      throw new Error('react-native-background-actions 4.1.0 task-removed patch did not match its native source')
    }

    await fs.writeFile(modulePath, moduleSource)
    await fs.writeFile(taskPath, taskSource)
    return config
  }])
}

module.exports = withBackgroundTaskRemoved
