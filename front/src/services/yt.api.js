import { Api } from "./api"

// Получает информацию о YouTube-видео: название, автор, длительность, список качеств.
export async function getVideoInfo(url) {
  const params = new URLSearchParams({ url })
  const response = await Api.fetchGet(`/youtube/info?${params}`, {
    400: "Не удалось получить информацию о видео. Проверьте ссылку",
  })

  return response.json()
}

// Возвращает прямую ссылку на скачивание видео.
export function getDownloadUrl(url, height) {
  const params = new URLSearchParams({ url, height })
  return `/api/youtube/download?${params}`
}

// Открывает ссылку на скачивание в браузере.
// Браузер сам качает файл и показывает прогресс в менеджере загрузок.
export function triggerDownload(url, filename) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}
