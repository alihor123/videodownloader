const { withAndroidColorsNight } = require('@expo/config-plugins')

function setColor(resources, name, value) {
  const colors = resources.color || []
  const existingColor = colors.find((color) => color.$.name === name)

  if (existingColor) existingColor._ = value
  else colors.push({ $: { name }, _: value })

  resources.color = colors
}

function withIconNightBackground(config) {
  return withAndroidColorsNight(config, (config) => {
    const resources = config.modResults.resources
    setColor(resources, 'iconBackground', '#171717')
    setColor(resources, 'splashscreen_background', '#171717')
    return config
  })
}

module.exports = withIconNightBackground
