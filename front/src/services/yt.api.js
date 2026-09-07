import { Api } from "./api"

// Интервал polling вынесен рядом с API-методом,
// чтобы UI мог использовать то же значение без магических чисел.
export const DOWNLOAD_TASK_POLL_INTERVAL_MS = 1000

// Метаданные ждём одним HTTP-запросом: сервер отменит worker при disconnect.
export async function getVideoInfo(url, taskId, signal) {
  const response = await Api.fetchPost('/media/info', { url, task_id: taskId }, {}, false, undefined, signal, true)
  return response.json()
}

// Запускает браузерное скачивание готовой ссылки.
export function triggerDownload(downloadUrl) {
  const a = document.createElement("a")
  a.href = downloadUrl
  a.download = ''
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

// Создает задачу скачивания на backend.
// signal позволяет прервать ожидание запроса на фронте.
export async function createDownloadTask(url, format, taskId, signal) {
  const response = await Api.fetchPost(
    "/media/download-tasks",
    {
      url,
      task_id: taskId,
      format: {
        height: format.height,
        fast: format.fast,
      },
    },
    {
      429: "Вы сделали слишком много запросов. Попробуйте чуть позже.",
    },
    false,
    undefined,
    signal,
    true
  )

  return response.json()
}

// Получает текущее состояние задачи по task_id.
// signal нужен, чтобы можно было прервать polling извне.
export async function getDownloadTask(taskId, signal) {
  const response = await Api.fetchGet(
    `/media/download-tasks/${taskId}`,
    {},
    false,
    undefined,
    signal
  )
  return response.json()
}

export async function getPlatforms(signal) {
  const response = await Api.fetchGet('/media/platforms', {}, false, undefined, signal)
  return response.json()
}

export function waitForPoll(signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
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

export async function cancelDownloadTask(taskId) {
  // Отдельный запрос без уже отменённого signal. keepalive помогает при уходе со страницы.
  const response = await Api.request(`/media/download-tasks/${taskId}`, {
    method: 'DELETE', keepalive: true,
  })
  return response.json()
}
