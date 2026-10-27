import { Api, ApiAbortError } from './api'
import type { MediaFormat, MediaInfo, MediaTask } from './media.types'

export const DOWNLOAD_TASK_POLL_INTERVAL_MS = 1_000

export async function getVideoInfo(url: string, taskId: string, signal: AbortSignal): Promise<MediaInfo> {
  const response = await Api.fetchPost('/media/info', { url, task_id: taskId }, {}, signal, true)
  return response.json() as Promise<MediaInfo>
}

export async function createDownloadTask(
  url: string,
  format: MediaFormat,
  taskId: string,
  signal: AbortSignal
): Promise<MediaTask> {
  const response = await Api.fetchPost('/media/download-tasks', {
    url,
    task_id: taskId,
    format: { height: format.height, kind: format.kind, fast: format.fast }
  }, { 429: 'Слишком много попыток. Попробуйте через минуту.' }, signal, true)
  return response.json() as Promise<MediaTask>
}

export async function getDownloadTask(taskId: string, signal: AbortSignal): Promise<MediaTask> {
  const response = await Api.fetchGet(`/media/download-tasks/${taskId}`, signal)
  return response.json() as Promise<MediaTask>
}

export async function cancelDownloadTask(taskId: string): Promise<MediaTask> {
  // Отмена не использует уже прерванный signal: этот запрос нужен даже после отмены локального запроса.
  const response = await Api.fetchDelete(`/media/download-tasks/${taskId}`)
  return response.json() as Promise<MediaTask>
}

export function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, DOWNLOAD_TASK_POLL_INTERVAL_MS)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ApiAbortError())
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}
