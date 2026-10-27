const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const projectRoot = path.join(__dirname, '..')

test('notification uses the supplied logo silhouette and an app-owned resource', () => {
  const logo = fs.readFileSync(path.join(projectRoot, 'assets/images/icon.svg'), 'utf8')
  const notification = fs.readFileSync(path.join(projectRoot, 'assets/images/notification-icon.xml'), 'utf8')
  const drawing = logo.match(/<path\b[^>]*\bd="([^"]+)"/)[1]
  assert.ok(notification.includes(`android:pathData="${drawing}"`))
  assert.match(notification, /android:fillColor="#FFFFFFFF"/)
  assert.match(notification, /android:fillType="evenOdd"/)
  const download = fs.readFileSync(path.join(projectRoot, 'src/services/download.service.ts'), 'utf8')
  assert.match(download, /taskIcon: \{ name: 'ic_stat_a4loader', type: 'drawable' \}/)
  assert.doesNotMatch(download, /stat_sys_download/)
})

test('launcher foreground has adaptive padding and a monochrome themed variant', () => {
  const foreground = fs.readFileSync(path.join(projectRoot, 'assets/images/adaptive-foreground.svg'), 'utf8')
  assert.match(foreground, /translate\(107\.52 107\.52\) scale\(0\.79\)/)
  const config = JSON.parse(fs.readFileSync(path.join(projectRoot, 'app.json'), 'utf8')).expo
  const monochrome = fs.readFileSync(path.join(projectRoot, config.android.adaptiveIcon.monochromeImage))
  assert.equal(monochrome.readUInt32BE(16), 1024)
  assert.equal(monochrome.readUInt32BE(20), 1024)
})

test('branding plugin copies the notification resource and keeps it through resource shrinking', async () => {
  const plugin = fs.readFileSync(path.join(projectRoot, 'plugins/withIconNightBackground.js'), 'utf8')
  const copies = []
  const writes = []
  let runMod
  const module = { exports: {} }
  vm.runInNewContext(plugin, {
    module,
    exports: module.exports,
    require(name) {
      if (name === 'node:path') return path
      if (name === 'node:fs/promises') return {
        mkdir: async () => undefined,
        copyFile: async (...args) => copies.push(args),
        writeFile: async (...args) => writes.push(args)
      }
      if (name === '@expo/config-plugins') return {
        withAndroidColorsNight: (config, action) => action(config),
        withDangerousMod: (config, [, action]) => {
          runMod = () => action(config)
          return config
        }
      }
      throw new Error(`Unexpected import: ${name}`)
    }
  })
  const config = {
    modRequest: { projectRoot: '/virtual', platformProjectRoot: '/virtual/android' },
    modResults: { resources: {} }
  }
  module.exports(config)
  await runMod()
  assert.equal(path.basename(copies[0][1]), 'ic_stat_a4loader.xml')
  assert.match(writes[0][1], /tools:keep="@drawable\/ic_stat_a4loader"/)
  assert.ok(config.modResults.resources.color.some(color => color.$.name === 'iconBackground' && color._ === '#171717'))
})

test('all mobile scroll views hide the vertical scrollbar', () => {
  const page = fs.readFileSync(path.join(projectRoot, 'src/pages/MainPage/MainPage.tsx'), 'utf8')
  const scrollViews = [...page.matchAll(/<ScrollView\b[^>]*>/g)]
  assert.equal(scrollViews.length, 2)
  for (const [tag] of scrollViews) assert.match(tag, /showsVerticalScrollIndicator=\{false\}/)
})
