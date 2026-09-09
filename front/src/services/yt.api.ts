import { Api } from './api'
import type { MediaFormat, MediaInfo, MediaTask, Platform } from './media.types'

export const DOWNLOAD_TASK_POLL_INTERVAL_MS = 1_000

export async function getVideoInfo(url: string, taskId: string, signal: AbortSignal): Promise<MediaInfo> {
  const response = await Api.fetchPost('/media/info', { url, task_id: taskId }, {}, signal, true)
  return response.json() as Promise<MediaInfo>
}

export function triggerDownload(downloadUrl: string): void {
  const link = document.createElement('a')
  link.href = downloadUrl
  link.download = ''
  document.body.append(link)
  link.click()
  link.remove()
}

export async function createDownloadTask(
  url: string,
  format: MediaFormat,
  taskId: string,
  signal: AbortSignal,
): Promise<MediaTask> {
  const response = await Api.fetchPost(
    '/media/download-tasks',
    { url, task_id: taskId, format: { height: format.height, kind: format.kind, fast: format.fast } },
    { 429: 'Вы сделали слишком много запросов. Попробуйте чуть позже.' },
    signal,
    true,
  )
  return response.json() as Promise<MediaTask>
}

export async function getDownloadTask(taskId: string, signal: AbortSignal): Promise<MediaTask> {
  const response = await Api.fetchGet(`/media/download-tasks/${taskId}`, signal)
  return response.json() as Promise<MediaTask>
}

export async function getPlatforms(signal: AbortSignal): Promise<Platform[]> {
  const response = await Api.fetchGet('/media/platforms', signal)
  return response.json() as Promise<Platform[]>
}

export function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer)
      reject(new DOMException('Операция отменена', 'AbortError'))
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, DOWNLOAD_TASK_POLL_INTERVAL_MS)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function cancelDownloadTask(taskId: string): Promise<MediaTask> {
  // Отмена не использует уже прерванный signal: этот запрос нужен даже при уходе со страницы.
  const response = await Api.request(`/media/download-tasks/${taskId}`, {
    method: 'DELETE',
    keepalive: true,
  })
  return response.json() as Promise<MediaTask>
}
