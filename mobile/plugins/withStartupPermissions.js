const fs = require('node:fs/promises')
const path = require('node:path')
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins')

function withStartupPermissions(config) {
  config = withAndroidManifest(config, (config) => {
    const permissions = config.modResults.manifest['uses-permission'] || []
    const name = 'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS'
    if (!permissions.some((permission) => permission.$['android:name'] === name)) {
      permissions.push({ $: { 'android:name': name } })
    }
    config.modResults.manifest['uses-permission'] = permissions
    return config
  })

  // Используем уже подключённый native-модуль службы, без ещё одной зависимости.
  return withDangerousMod(config, ['android', async (config) => {
    const modulePath = path.join(config.modRequest.projectRoot, 'node_modules',
      'react-native-background-actions', 'android', 'src', 'main', 'java',
      'com', 'asterinet', 'react', 'bgactions', 'BackgroundActionsModule.java')
    let source = await fs.readFile(modulePath, 'utf8')
    if (source.includes('A4_STARTUP_PERMISSIONS_PATCH')) return config

    const anchor = '    @SuppressWarnings("unused")\n    @ReactMethod\n    public void start('
    if (!source.includes(anchor)) throw new Error('BackgroundActionsModule start method was not found')

    for (const javaImport of [
      'android.net.Uri',
      'android.os.PowerManager',
      'android.provider.Settings',
      'com.facebook.react.bridge.UiThreadUtil'
    ]) {
      if (!source.includes(`import ${javaImport};`)) {
        source = source.replace('import android.content.Intent;', `import android.content.Intent;\nimport ${javaImport};`)
      }
    }

    source = source.replace(anchor, `    @ReactMethod
    public void isIgnoringBatteryOptimizations(final Promise promise) {
        final PowerManager powerManager = (PowerManager) reactContext.getSystemService(Context.POWER_SERVICE);
        promise.resolve(powerManager.isIgnoringBatteryOptimizations(reactContext.getPackageName()));
    }

    @ReactMethod
    public void requestBatteryOptimizationExemption(final Promise promise) {
        UiThreadUtil.runOnUiThread(() -> {
            try {
                final Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                intent.setData(Uri.parse("package:" + reactContext.getPackageName()));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                reactContext.startActivity(intent);
                promise.resolve(null);
            } catch (Exception error) {
                promise.reject("A4_BACKGROUND_PERMISSION", error);
            }
        });
    } // A4_STARTUP_PERMISSIONS_PATCH

${anchor}`)

    await fs.writeFile(modulePath, source)
    return config
  }])
}

module.exports = withStartupPermissions
