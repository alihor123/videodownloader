const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')

async function main() {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    let thumbnail = ''
    let releaseImage
    let imageRequested = false
    let imageResponse
    await page.route('https://preview.test/**', async route => {
      imageRequested = true
      await new Promise(resolve => { releaseImage = resolve })
      await route.fulfill(imageResponse)
    })
    await page.route('**/api/media/info', route => route.fulfill({ json: {
      title: 'Проверочное название видео на несколько строк без изменения остального интерфейса',
      uploader: 'Автор', duration: '1:04', views: '920 847', thumbnail,
      platform: 'youtube', platform_name: 'YouTube', url: 'https://youtube.com/watch?v=test',
      formats: [{ height: 720, kind: 'video', label: '720p', ext: 'mp4', size: '~15 MB', fast: false }]
    } }))
    await page.goto(process.env.UI_BASE_URL || 'http://127.0.0.1:5179')
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await fs.mkdir('tmp/ui-checks', { recursive: true })

    for (const [viewport, imageSize, height, maxWidth] of [
      [{ width: 390, height: 844 }, [160, 90], 65, 116],
      [{ width: 390, height: 844 }, [90, 160], 65, 116],
      [{ width: 720, height: 900 }, [160, 90], 100, 190],
      [{ width: 1280, height: 900 }, [160, 90], 110, 220]
    ]) {
      await page.setViewportSize(viewport)
      thumbnail = `https://preview.test/${viewport.width}-${imageSize[0]}.svg`
      imageRequested = false
      releaseImage = undefined
      imageResponse = {
        contentType: 'image/svg+xml',
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="${imageSize[0]}" height="${imageSize[1]}"><rect width="100%" height="100%" fill="#df102c"/></svg>`
      }
      await page.getByRole('textbox').fill('https://youtube.com/watch?v=test')
      await page.getByRole('button', { name: 'Найти', exact: true }).click()
      const preview = page.locator('[data-loading]')
      await preview.waitFor()
      await page.waitForFunction(() => document.querySelector('[data-loading="true"]'))
      assert.equal(await page.getByText('Автор', { exact: true }).isVisible(), true)
      const pendingSize = await preview.boundingBox()
      assert.equal(pendingSize.height, height)
      assert.ok(Math.abs(pendingSize.width - Math.min(maxWidth, height * 16 / 9)) < 1)
      for (let attempt = 0; !imageRequested && attempt < 30; attempt++) await page.waitForTimeout(20)
      assert.ok(releaseImage)
      if (viewport.width === 390 && imageSize[0] === 160) {
        await page.screenshot({ path: 'tmp/ui-checks/preview-loading.png' })
      }
      releaseImage()
      await page.waitForFunction(() => document.querySelector('[data-loading="false"]'))
      const loadedSize = await preview.boundingBox()
      assert.equal(loadedSize.height, height)
      assert.ok(Math.abs(loadedSize.width - Math.min(maxWidth, height * imageSize[0] / imageSize[1])) < 1)
      assert.equal(await preview.locator('span').count(), 0)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: `tmp/ui-checks/preview-${viewport.width}-${imageSize[0]}.png` })
    }

    thumbnail = 'https://preview.test/error.svg'
    releaseImage = undefined
    imageResponse = { status: 404, body: '' }
    await page.getByRole('button', { name: 'Найти', exact: true }).click()
    await page.locator('[data-loading="true"]').waitFor()
    for (let attempt = 0; !releaseImage && attempt < 30; attempt++) await page.waitForTimeout(20)
    releaseImage()
    await page.locator('[data-loading]').waitFor({ state: 'detached' })
    assert.equal(await page.getByText('Автор', { exact: true }).isVisible(), true)
    assert.deepEqual(errors, [])
    console.log('PASS: preview skeleton, URL reset, landscape/portrait, 3 breakpoints, image error, no overflow')
  } finally {
    await browser.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
