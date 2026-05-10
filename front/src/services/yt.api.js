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
// Браузер сам покажет прогресс-бар при переходе по этой ссылке.
export function getDownloadUrl(url, height) {
  const params = new URLSearchParams({ url, height })
  return `/api/youtube/download?${params}`
}
