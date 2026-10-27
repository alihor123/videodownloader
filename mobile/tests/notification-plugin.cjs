const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const pluginSource = fs.readFileSync(path.join(__dirname, '../plugins/withBackgroundTaskRemoved.js'), 'utf8')
const nativeRoot = path.join(__dirname, '../node_modules/react-native-background-actions/android/src/main/java/com/asterinet/react/bgactions')

function createHarness(invalidSource = false) {
  const sources = new Map([
    ['BackgroundActionsModule.java', invalidSource ? '' : fs.readFileSync(path.join(nativeRoot, 'BackgroundActionsModule.java'), 'utf8')],
    ['RNBackgroundActionsTask.java', fs.readFileSync(path.join(nativeRoot, 'RNBackgroundActionsTask.java'), 'utf8')]
  ])
  let runMod
  let writes = 0
  const module = { exports: {} }
  vm.runInNewContext(pluginSource, {
    module,
    exports: module.exports,
    require(name) {
      if (name === 'node:path') return path
      if (name === 'node:fs/promises') return {
        readFile: async file => sources.get(path.basename(file)),
        writeFile: async (file, contents) => {
          writes += 1
          sources.set(path.basename(file), contents)
        }
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
  module.exports({
    modRequest: { projectRoot: '/virtual' },
    modResults: { manifest: { application: [{}] } }
  })
  return { sources, run: () => runMod(), writes: () => writes }
}

test('completion keeps the same notification, detaches it and clears progress without leaving a service running', async () => {
  const harness = createHarness()
  await harness.run()
  const task = harness.sources.get('RNBackgroundActionsTask.java')
  const nativeModule = harness.sources.get('BackgroundActionsModule.java')
  const completion = task.slice(task.indexOf('public static void completeNotification('), task.indexOf('public void onDestroy()'))
  assert.match(completion, /setOngoing\(false\)/)
  assert.match(completion, /setAutoCancel\(true\)/)
  assert.match(completion, /setOnlyAlertOnce\(true\)/)
  assert.match(completion, /setProgress\(0, 0, false\)/)
  assert.match(completion, /notify\(SERVICE_NOTIFICATION_ID, completed\)/)
  assert.ok(completion.indexOf('stopForeground(STOP_FOREGROUND_DETACH)') < completion.indexOf('.notify('))
  assert.match(nativeModule, /UiThreadUtil\.runOnUiThread/)
  assert.match(task, /if \(a4ActiveTask == this\) a4ActiveTask = null/)

  await harness.run()
  assert.equal(harness.sources.get('RNBackgroundActionsTask.java'), task)
  assert.equal(harness.sources.get('BackgroundActionsModule.java'), nativeModule)
})

test('a changed native module fails before writing a partially applied patch', async () => {
  const harness = createHarness(true)
  await assert.rejects(harness.run(), /start method was not found/)
  assert.equal(harness.writes(), 0)
})
