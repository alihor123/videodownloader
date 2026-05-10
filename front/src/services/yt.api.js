import { Api } from "./api"

// Получает информацию о YouTube-видео: название, автор, длительность, список качеств.
export async function getVideoInfo(url) {
  const params = new URLSearchParams({ url })
  const response = await Api.fetchGet(`/youtube/info?${params}`, {
    400: "Не удалось получить информацию о видео. Проверьте ссылку",
  })

  return response.json()
}

// Скачивает видео в выбранном качестве. Возвращает Blob и имя файла.
export async function downloadVideo(url, height) {
  const params = new URLSearchParams({ url, height })
  const response = await Api.fetchGet(`/youtube/download?${params}`, {
    400: "Не удалось скачать видео. Попробуйте другое качество или проверьте ссылку",
  })

  const blob = await response.blob()

  // Достаём имя файла из заголовка Content-Disposition
  let filename = 'video.mp4'
  const disposition = response.headers.get('Content-Disposition')
  if (disposition) {
    const match = disposition.match(/filename="?(.+?)"?$/)
    if (match) filename = match[1]
  }

  return { blob, filename }
}
