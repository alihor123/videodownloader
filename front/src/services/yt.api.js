import { Api } from "./api"

// Получает информацию о YouTube-видео: название, автор, длительность, список качеств.
export async function getVideoInfo(url) {
  const params = new URLSearchParams({ url })
  const response = await Api.fetchGet(`/youtube/info?${params}`, {
    400: "Не удалось получить информацию о видео. Проверьте ссылку",
  })

  return response.json()
}

// Открывает ссылку на скачивание в браузере.
// Браузер сам качает файл и показывает прогресс в менеджере загрузок.
export function triggerDownload(url, height, path = "/download-file") {
  const params = new URLSearchParams({ url, height })
  const a = document.createElement('a')
  a.href = `/api/youtube${path}?${params}`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}


// Запускает скачивание выбранного формата через серверный поток.
export function downloadVideo(url, format) {
  if (format?.fast) {
    triggerDownload(url, format.height, "/download-stream")
    return
  }

  triggerDownload(url, format.height)
}


//////////////////////////////////////////////////////////////////////////


// Механика скачивания через прямую ссылку в новом окне.
// Открывает пустую вкладку сразу по клику, чтобы браузер не счёл её popup.
export function openBlankTab() {
  const tab = window.open('about:blank', '_blank')
  if (tab) {
    tab.opener = null
  }

  return tab
}

// Получает прямую ссылку для быстрых форматов, которые YouTube отдаёт без склейки.
export async function getDirectDownloadUrl(url, height) {
  const params = new URLSearchParams({ url, height })
  const response = await Api.fetchGet(`/youtube/download-url?${params}`, {
    400: "Не удалось получить быструю ссылку. Попробуйте обычное скачивание",
    404: "Быстрая ссылка не найдена",
  })

  return response.json()
}

// Запускает скачивание выбранного формата через прямую ссылку в новом окне.
export async function downloadVideoInNewWindow(url, format) {
  if (!format?.fast) {
    triggerDownload(url, format.height)
    return
  }

  const tab = openBlankTab()

  try {
    const data = await getDirectDownloadUrl(url, format.height)
    if (tab) {
      tab.location.href = data.url
    } else {
      window.open(data.url, '_blank', 'noopener,noreferrer')
    }
  } catch (error) {
    if (tab) {
      tab.close()
    }

    if (error.status === 404) {
      triggerDownload(url, format.height)
      return
    }

    throw error
  }
}