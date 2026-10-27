const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const source = fs.readFileSync(path.join(__dirname, '../src/components/VideoThumbnail.tsx'), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
}).outputText

function createPreview(props) {
  let image
  const element = (type, props) => ({ type, props })
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require(name) {
      if (name === 'react') return {
        useState(initial) {
          image ??= initial
          return [image, value => { image = value }]
        }
      }
      if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element }
      if (name === 'react-native') return { View: 'View' }
      if (name === 'expo-image') return { Image: 'Image' }
      if (name === '@/hooks/useStyles') return { useStyles: factory => factory({ bgMuted: '#272727' }) }
      if (name === './ThumbnailSkeleton') return { __esModule: true, default: 'ThumbnailSkeleton' }
      throw new Error(`Unexpected import: ${name}`)
    }
  })
  return () => module.exports.default(props)
}

for (const [height, maxWidth] of [[65, 116], [100, 190], [110, 220]]) {
  test(`preview uses web size ${height}/${maxWidth}, skeleton and intrinsic image ratio`, () => {
    const render = createPreview({ src: 'https://preview.test/video.jpg', height, maxWidth, borderRadius: 11 })
    let tree = render()
    assert.equal(tree.props.style.height, height)
    assert.ok(Math.abs(tree.props.style.width - Math.min(maxWidth, height * 16 / 9)) < 0.001)
    assert.equal(tree.props.children[0].type, 'ThumbnailSkeleton')
    assert.equal(tree.props.children[1].props.style.opacity, 0)
    assert.equal(tree.props.children[1].props.contentFit, 'contain')

    tree.props.children[1].props.onLoad({ source: { width: 90, height: 160 } })
    tree = render()
    assert.equal(tree.props.children[0], false)
    assert.equal(tree.props.children[1].props.style.opacity, 1)
    assert.equal(tree.props.style.width, height * 90 / 160)
    assert.equal(tree.props.style.height, height)
  })
}

test('failed preview hides its skeleton and frame without affecting metadata', () => {
  const render = createPreview({ src: 'https://preview.test/error.jpg', height: 65, maxWidth: 116, borderRadius: 11 })
  render().props.children[1].props.onError()
  assert.equal(render(), null)
})

test('a newly mounted preview starts with a skeleton again', () => {
  const first = createPreview({ src: 'https://preview.test/one.jpg', height: 65, maxWidth: 116, borderRadius: 11 })
  first().props.children[1].props.onLoad({ source: { width: 160, height: 90 } })
  assert.equal(first().props.children[0], false)
  const next = createPreview({ src: 'https://preview.test/two.jpg', height: 65, maxWidth: 116, borderRadius: 11 })
  assert.equal(next().props.children[0].type, 'ThumbnailSkeleton')
})
