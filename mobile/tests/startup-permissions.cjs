const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const sourcePath = path.join(__dirname, '../src/services/permissions.service.ts')
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function createHarness({ version = 36, exempt = false, os = 'android', oldNative = false } = {}) {
  const calls = []
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: () => ({
      Platform: { OS: os, Version: version },
      PermissionsAndroid: {
        PERMISSIONS: { WRITE_EXTERNAL_STORAGE: 'storage', POST_NOTIFICATIONS: 'notifications' },
        request: async permission => { calls.push(permission) }
      },
      NativeModules: { RNBackgroundActions: oldNative ? {} : {
        isIgnoringBatteryOptimizations: async () => { calls.push('check-background'); return exempt },
        requestBatteryOptimizationExemption: async () => { calls.push('request-background') }
      } }
    })
  }, { filename: sourcePath })
  return { request: module.exports.requestStartupPermissions, calls }
}

test('Android 13+ requests notifications then background, not storage access', async () => {
  const harness = createHarness()
  await Promise.all([harness.request(), harness.request()])
  await harness.request()
  assert.deepEqual(harness.calls, ['notifications', 'check-background', 'request-background'])
})

test('Android 9 requests storage before the background dialog', async () => {
  const harness = createHarness({ version: 28 })
  await harness.request()
  assert.deepEqual(harness.calls, ['storage', 'check-background', 'request-background'])
})

test('Android 10-12 saves owned MediaStore files without storage or notification prompts', async () => {
  const harness = createHarness({ version: 31 })
  await harness.request()
  assert.deepEqual(harness.calls, ['check-background', 'request-background'])
})

test('does not request a battery exception that has already been granted', async () => {
  const harness = createHarness({ exempt: true })
  await harness.request()
  assert.deepEqual(harness.calls, ['notifications', 'check-background'])
})

test('a stale dev build without the new native methods does not crash startup', async () => {
  const harness = createHarness({ oldNative: true })
  await harness.request()
  assert.deepEqual(harness.calls, ['notifications'])
})

test('does not request Android permissions on another platform', async () => {
  const harness = createHarness({ os: 'ios' })
  await harness.request()
  assert.deepEqual(harness.calls, [])
})

test('startup native plugin adds the permission and applies its bridge patch once', async () => {
  const pluginSource = fs.readFileSync(path.join(__dirname, '../plugins/withStartupPermissions.js'), 'utf8')
  let nativeSource = fs.readFileSync(path.join(__dirname, '../node_modules/react-native-background-actions/android/src/main/java/com/asterinet/react/bgactions/BackgroundActionsModule.java'), 'utf8')
  let runMod
  const module = { exports: {} }
  vm.runInNewContext(pluginSource, {
    module,
    exports: module.exports,
    require(name) {
      if (name === 'node:path') return path
      if (name === 'node:fs/promises') return {
        readFile: async () => nativeSource,
        writeFile: async (_, contents) => { nativeSource = contents }
      }
      if (name === '@expo/config-plugins') return {
        withAndroidManifest: (config, action) => action(config),
        withDangerousMod: (config, [, action]) => {
          runMod = () => action(config)
          return config
        }
      }
      throw new Error(`Unexpected import: ${name}`)
    }
  })
  const config = { modRequest: { projectRoot: '/virtual' }, modResults: { manifest: {} } }
  module.exports(config)
  await runMod()
  assert.equal(config.modResults.manifest['uses-permission'][0].$['android:name'], 'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS')
  assert.match(nativeSource, /powerManager\.isIgnoringBatteryOptimizations\(reactContext\.getPackageName\(\)\)/)
  assert.match(nativeSource, /Settings\.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS/)
  assert.match(nativeSource, /Uri\.parse\("package:" \+ reactContext\.getPackageName\(\)\)/)
  const once = nativeSource
  module.exports(config)
  await runMod()
  assert.equal(nativeSource, once)
  assert.equal(config.modResults.manifest['uses-permission'].length, 1)
})
