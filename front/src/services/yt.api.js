import { Api } from "./api"

// Получает информацию о YouTube-видео: название, автор, длительность, список качеств.
export async function getVideoInfo(url) {
  const params = new URLSearchParams({ url })
  const response = await Api.fetchGet(`/youtube/info?${params}`, {
    400: "Не удалось получить информацию о видео. Проверьте ссылку",
  })

  return response.json()
}

// Скачивает видео в выбранном качестве. Возвращает Blob — его можно сохранить через URL.createObjectURL + <a> или showSaveFilePicker.
export async function downloadVideo(url, height) {
  const params = new URLSearchParams({ url, height })
  const response = await Api.fetchGet(`/youtube/download?${params}`, {
    400: "Не удалось скачать видео. Попробуйте другое качество или проверьте ссылку",
  })

  return response.blob()
}
