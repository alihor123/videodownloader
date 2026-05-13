import { Api } from "./api"

// Интервал polling вынесен рядом с API-методом,
// чтобы UI мог использовать то же значение без магических чисел.
export const DOWNLOAD_TASK_POLL_INTERVAL_MS = 1000

// Получает информацию о YouTube-видео.
// Поиск информации специально не отменяется кнопкой "Отмена" в текущем UX.
export async function getVideoInfo(url) {
  const params = new URLSearchParams({ url })
  const response = await Api.fetchGet(`/youtube/info?${params}`, {
    400: "Не удалось получить информацию о видео. Проверьте ссылку",
  })

  return response.json()
}

// Запускает браузерное скачивание готовой ссылки.
export function triggerDownload(downloadUrl) {
  const a = document.createElement("a")
  a.href = downloadUrl
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

// Создает задачу скачивания на backend.
// signal позволяет прервать ожидание запроса на фронте.
export async function createDownloadTask(url, format, signal) {
  const response = await Api.fetchPost(
    "/youtube/download-tasks",
    {
      url,
      format: {
        height: format.height,
        fast: format.fast,
      },
    },
    {
      429: "Вы сделали слишком много запросов. Попробуйте чуть позже или скачайте файл с меткой fast.",
    },
    false,
    undefined,
    signal
  )

  return response.json()
}

// Получает текущее состояние задачи по task_id.
// signal нужен, чтобы можно было прервать polling извне.
export async function getDownloadTask(taskId, signal) {
  const response = await Api.fetchGet(
    `/youtube/download-tasks/${taskId}`,
    {},
    false,
    undefined,
    signal
  )
  return response.json()
}
