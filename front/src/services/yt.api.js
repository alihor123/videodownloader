import { Api, ApiError } from "./api"

const DOWNLOAD_TASK_POLL_INTERVAL_MS = 1000
const MAX_POLL_NETWORK_ERRORS = 3

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

// Получает информацию о YouTube-видео: название, автор, длительность, список качеств.
export async function getVideoInfo(url) {
  const params = new URLSearchParams({ url })
  const response = await Api.fetchGet(`/youtube/info?${params}`, {
    400: "Не удалось получить информацию о видео. Проверьте ссылку",
  })

  return response.json()
}

// Открывает готовую ссылку на скачивание в браузере.
// Браузер сам качает файл и показывает прогресс в менеджере загрузок.
export function triggerDownload(downloadUrl) {
  const a = document.createElement("a")
  a.href = downloadUrl
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

// Создает задачу скачивания: ошибки и статусы теперь живут в task API.
export async function createDownloadTask(url, format) {
  const response = await Api.fetchPost("/youtube/download-tasks", {
    url,
    format: {
      height: format.height,
      fast: format.fast,
    },
  }, {
    429: "Слишком много запросов. Попробуйте чуть позже или скачайте файл с меткой fast.",
  })

  return response.json()
}

// Получает свежее состояние задачи.
export async function getDownloadTask(taskId) {
  const response = await Api.fetchGet(`/youtube/download-tasks/${taskId}`)

  return response.json()
}

export async function waitDownloadTaskReady(initialTask, onUpdate) {
  let task = initialTask
  let pollNetworkErrorCount = 0
  onUpdate(task)

  while (task.status !== "ready" && task.status !== "failed") {
    await wait(DOWNLOAD_TASK_POLL_INTERVAL_MS)

    try {
      task = await getDownloadTask(task.task_id)
      pollNetworkErrorCount = 0
      onUpdate(task)
    } catch (error) {
      if (error instanceof ApiError && !error.status) {
        pollNetworkErrorCount += 1

        if (pollNetworkErrorCount <= MAX_POLL_NETWORK_ERRORS) {
          continue
        }
      }

      throw error
    }
  }

  return task
}
