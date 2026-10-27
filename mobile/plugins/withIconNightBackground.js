const fs = require('node:fs/promises')
const path = require('node:path')
const { withAndroidColorsNight, withDangerousMod } = require('@expo/config-plugins')

function setColor(resources, name, value) {
  const colors = resources.color || []
  const existingColor = colors.find((color) => color.$.name === name)

  if (existingColor) existingColor._ = value
  else colors.push({ $: { name }, _: value })

  resources.color = colors
}

function withIconNightBackground(config) {
  config = withAndroidColorsNight(config, (config) => {
    const resources = config.modResults.resources
    setColor(resources, 'iconBackground', '#171717')
    setColor(resources, 'splashscreen_background', '#171717')
    return config
  })

  return withDangerousMod(config, ['android', async (config) => {
    const resources = path.join(config.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res')
    await fs.mkdir(path.join(resources, 'drawable'), { recursive: true })
    await fs.mkdir(path.join(resources, 'raw'), { recursive: true })
    await fs.copyFile(
      path.join(config.modRequest.projectRoot, 'assets', 'images', 'notification-icon.xml'),
      path.join(resources, 'drawable', 'ic_stat_a4loader.xml')
    )
    // Имя значка передаётся строкой: явно сохраняем ресурс при release-оптимизации.
    await fs.writeFile(path.join(resources, 'raw', 'a4loader_keep.xml'),
      '<resources xmlns:tools="http://schemas.android.com/tools" tools:keep="@drawable/ic_stat_a4loader" />\n')
    return config
  }])
}

module.exports = withIconNightBackground
