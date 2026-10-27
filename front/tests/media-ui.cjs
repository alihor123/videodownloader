// Запуск: node tests/media-ui.cjs. PLAYWRIGHT_MODULE — путь к установленному playwright.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')

async function main() {
  const launchOptions = { headless: true }
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH
  }
  const browser = await chromium.launch(launchOptions)
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/**', async route => {
    const response = await route.fetch({ url: route.request().url().replace('http://127.0.0.1:5179', 'http://127.0.0.1:8011') })
    await route.fulfill({ response })
  })
  await fs.mkdir('tmp/ui-checks', { recursive: true })
  await page.goto('http://127.0.0.1:5179')
  await page.getByText('VK Видео', { exact: true }).waitFor()
  assert.equal(await page.getByText('Вставляйте ссылку на публичное видео с любого из этих сервисов.', { exact: true }).count(), 0)
  await page.screenshot({ path: 'tmp/ui-checks/desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: 'tmp/ui-checks/mobile.png', fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark')
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'tmp/ui-checks/mobile-dark.png', fullPage: true })

  // Детерминированный API проверяет гонку POST/DELETE независимо от внешних сайтов.
  const tasks = new Map()
  const cancellations = []
  let downloadCreates = 0
  let infoStatusRequests = 0
  let delayCreate = true
  let sendNextDownload = false
  const info = { title: 'Проверочное видео', uploader: 'Автор', duration: '0:12', views: '100',
    thumbnail: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="%23df102c"/></svg>',
    platform: 'vk', platform_name: 'VK Видео', url: 'https://vk.com/video-1_2',
    formats: [{ height: 720, kind: 'video', label: '720p', ext: 'mp4', size: '~2 MB', fast: false }] }
  await page.unroute('**/api/**')
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'DELETE') {
      const id = path.split('/').at(-1)
      cancellations.push(id)
      tasks.set(id, { task_id: id, status: 'cancelled', stage: 'cancelled', message: 'Загрузка отменена' })
      return route.fulfill({ json: tasks.get(id) })
    }
    if (request.method() === 'POST') {
      const body = request.postDataJSON()
      if (delayCreate) await new Promise(resolve => setTimeout(resolve, 1000))
      if (!path.endsWith('/info')) downloadCreates += 1
      const task = tasks.get(body.task_id) || {
        task_id: body.task_id,
        status: path.endsWith('/info') ? 'ready' : sendNextDownload ? 'ready' : 'running',
        result: path.endsWith('/info') ? info : null, stage: 'downloading_file', message: 'Скачиваем файл', progress: 50,
        download_url: !path.endsWith('/info') && sendNextDownload ? `/api/media/download-tasks/${body.task_id}/download` : null,
      }
      if (!path.endsWith('/info')) sendNextDownload = false
      tasks.set(body.task_id, task)
      return route.fulfill({ json: path.endsWith('/info') ? info : task })
    }
    if (request.method() === 'GET' && path.endsWith('/download')) {
      const id = path.split('/').at(-2)
      const task = tasks.get(id)
      task.status = 'sending'
      tasks.set(id, task)
      return route.fulfill({ status: 200, body: 'test file' })
    }
    if (path.includes('/download-tasks/')) infoStatusRequests += 1
    const id = path.split('/').at(-1)
    const task = tasks.get(id)
    if (task?.status === 'ready' && task.download_url) task.status = 'sending'
    return route.fulfill({ json: task })
  })
  await page.getByRole('textbox').fill(info.url)
  await page.getByRole('button', { name: 'Найти', exact: true }).click()
  await page.getByText('Скопируйте ссылку', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Отменить', exact: true }).click()
  await page.getByRole('button', { name: 'Найти', exact: true }).waitFor()
  assert.equal(cancellations.length, 1)
  assert.equal(tasks.get(cancellations[0]).status, 'cancelled')
  console.log('PASS: cancel before POST response')

  delayCreate = false
  await page.getByRole('button', { name: 'Найти', exact: true }).click()
  await page.getByText(info.title, { exact: true }).waitFor()
  assert.equal(await page.getByText('Скопируйте ссылку', { exact: true }).count(), 0)
  assert.equal(await page.getByText(info.views, { exact: true }).count(), 1)
  assert.equal(await page.locator('img').count(), 1)
  assert.equal(infoStatusRequests, 0)
  console.log('PASS: metadata search uses one POST without status polling')

  const selectedQuality = page.getByRole('button', { name: /720p/ })
  const selectedAppearance = await selectedQuality.evaluate(element => {
    const style = getComputedStyle(element)
    return { shadow: style.boxShadow, border: style.borderColor, background: style.backgroundColor }
  })
  await selectedQuality.hover()
  await page.waitForTimeout(250)
  const selectedHoverAppearance = await selectedQuality.evaluate(element => {
    const style = getComputedStyle(element)
    return { shadow: style.boxShadow, border: style.borderColor, background: style.backgroundColor }
  })
  assert.equal(selectedAppearance.shadow, 'none')
  assert.equal(selectedAppearance.border, 'rgba(0, 0, 0, 0)')
  assert.notEqual(selectedAppearance.background, 'rgba(0, 0, 0, 0)')
  assert.deepEqual(selectedHoverAppearance, selectedAppearance)
  console.log('PASS: selected quality keeps its colored background without a border on hover')
  await page.getByRole('button', { name: 'Скачать', exact: true }).click()
  await page.getByText('Скачиваем файл...', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Отменить', exact: true }).click()
  await page.getByText('Загрузка отменена', { exact: true }).waitFor()
  assert.equal(tasks.get(cancellations.at(-1)).status, 'cancelled')
  console.log('PASS: download cancel waits for server acknowledgment')

  await page.getByRole('button', { name: 'Скачать', exact: true }).click()
  await page.getByText('Скачиваем файл...', { exact: true }).waitFor()
  const before = cancellations.length
  await page.getByRole('textbox').fill('https://youtu.be/other')
  await page.getByRole('button', { name: 'Найти', exact: true }).click()
  await page.getByText(info.title, { exact: true }).waitFor()
  assert.ok(cancellations.length > before)
  console.log('PASS: new search cancels previous server download')
  await page.getByRole('button', { name: 'Очистить поиск' }).click()
  await page.getByText('Скопируйте ссылку', { exact: true }).waitFor()
  assert.equal(await page.getByRole('textbox').inputValue(), '')
  assert.equal(await page.getByText(info.title, { exact: true }).count(), 0)
  console.log('PASS: clear button resets the result and restores instructions')

  sendNextDownload = true
  await page.getByRole('textbox').fill(info.url)
  await page.getByRole('button', { name: 'Найти', exact: true }).click()
  await page.getByText(info.title, { exact: true }).waitFor()
  const createsBeforeTransfer = downloadCreates
  const cancellationsBeforeTransfer = cancellations.length
  await page.getByRole('button', { name: 'Скачать', exact: true }).click()
  await page.getByRole('button', { name: 'Скачать', exact: true }).waitFor()
  assert.equal(cancellations.length, cancellationsBeforeTransfer)
  assert.equal(downloadCreates, createsBeforeTransfer + 1)
  console.log('PASS: sending releases the frontend operation without cancellation')

  await page.getByRole('button', { name: 'Скачать', exact: true }).click()
  await page.getByText('Скачиваем файл...', { exact: true }).waitFor()
  assert.equal(downloadCreates, createsBeforeTransfer + 2)
  console.log('PASS: download can be started again after sending')
  assert.deepEqual(errors, [])
  console.log('PASS: desktop/mobile/dark layout; no horizontal overflow or JS errors')
  await browser.close()
}

main().catch(error => { console.error(error); process.exit(1) })
