const { withAppBuildGradle } = require('@expo/config-plugins')

// Старый Ninja в Android SDK на Windows не умеет пути длиннее 260 символов.
module.exports = function withShortCmakePaths(config) {
  return withAppBuildGradle(config, (config) => {
    if (!config.modResults.contents.includes('A4_SHORT_CMAKE_PATHS')) {
      const anchor = '    defaultConfig {'
      if (!config.modResults.contents.includes(anchor)) throw new Error('Android defaultConfig was not found')
      config.modResults.contents = config.modResults.contents.replace(anchor, `${anchor}
        // A4_SHORT_CMAKE_PATHS: CMake хеширует длинные пути объектных файлов.
        externalNativeBuild {
            cmake {
                arguments "-DCMAKE_OBJECT_PATH_MAX=255"
            }
        }`)
    }
    return config
  })
}
