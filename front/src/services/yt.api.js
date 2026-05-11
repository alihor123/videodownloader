import { Api, ApiError } from "./api"

const DOWNLOAD_TASK_POLL_INTERVAL_MS = 2000

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

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

// Создает задачу скачивания: ошибки и статусы теперь живут в task API.
export async function createDownloadTask(url, format) {
  const response = await Api.fetchPost("/youtube/download-tasks", {
    url,
    format: {
      height: format.height,
      fast: format.fast,
    },
  })

  return response.json()
}

// Получает свежее состояние задачи.
export async function getDownloadTask(taskId) {
  const response = await Api.fetchGet(`/youtube/download-tasks/${taskId}`)

  return response.json()
}

// Ждет готовности задачи и запускает нативное скачивание готового результата.
export async function downloadVideo(url, format) {
  let task = await createDownloadTask(url, format)

  while (task.status !== "ready" && task.status !== "failed") {
    await wait(DOWNLOAD_TASK_POLL_INTERVAL_MS)
    task = await getDownloadTask(task.task_id ?? task.id)
    console.log(task.message)
  }

  if (task.status === "failed") {
    throw new ApiError(
      task.error || task.message || "Не удалось подготовить скачивание",
      400
    )
  }

  triggerDownload(task.download_url)
}
