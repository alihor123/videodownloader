import { useEffect, useState } from 'react'
import { useDelayedLoading } from './useDelayedLoading'
import { ApiAbortError, ApiError } from '../services/api'
import {
  cancelActiveDownload,
  createTaskId,
  fetchMediaInfo,
  getDownloadSnapshot,
  resetDownloadSnapshot,
  startDownload,
  subscribeToDownload,
  type DownloadSnapshot
} from '../services/download.service'
import { cancelDownloadTask } from '../services/yt.api'
import type { MediaFormat, MediaInfo, MediaTask } from '../services/media.types'

interface SearchOperation {
  id: string
  controller: AbortController
}

let rememberedSearchQuery = ''
let rememberedSelectedFormat: MediaFormat | null = null
let rememberedVideoData: MediaInfo | null = null
let searchOperation: SearchOperation | null = null

const EMPTY_DOWNLOAD: DownloadSnapshot = getDownloadSnapshot()

export function useMediaController() {
  const [searchQueryState, setSearchQueryState] = useState(rememberedSearchQuery)
  const [selectedFormatState, setSelectedFormatState] = useState<MediaFormat | null>(rememberedSelectedFormat)
  const [videoData, setVideoData] = useState<MediaInfo | null>(rememberedVideoData)
  const [download, setDownload] = useState(EMPTY_DOWNLOAD)
  const [isLoading, setLoading] = useDelayedLoading()
  const [infoError, setInfoError] = useState<string | null>(null)
  const [isSearchCancelling, setSearchCancelling] = useState(false)

  useEffect(() => subscribeToDownload(setDownload), [])

  function setSearchQuery(value: string): void {
    rememberedSearchQuery = value
    setSearchQueryState(value)
  }

  function setSelectedFormat(value: MediaFormat | null): void {
    rememberedSelectedFormat = value
    setSelectedFormatState(value)
  }

  async function fetchVideo(): Promise<void> {
    const url = searchQueryState.trim()
    if (!url || !await cancelDownloadFlow()) return
    resetDownloadSnapshot()
    // UUID известен до POST: отмена сможет найти задачу, даже если ответ ещё не пришёл.
    const current = { id: createTaskId(), controller: new AbortController() }
    searchOperation = current
    setLoading(true)
    setVideoData(null)
    rememberedVideoData = null
    setSelectedFormat(null)
    setInfoError(null)

    try {
      const data = await fetchMediaInfo(url, current.id, current.controller.signal)
      if (searchOperation !== current || current.controller.signal.aborted) return
      setVideoData(data)
      rememberedVideoData = data
      setSelectedFormat(data.formats[0] ?? null)
    } catch (error) {
      if (current.controller.signal.aborted || searchOperation !== current || error instanceof ApiAbortError) return
      setInfoError(error instanceof ApiError ? error.message : 'Не удалось получить информацию о видео.')
    } finally {
      if (searchOperation === current && !current.controller.signal.aborted) {
        searchOperation = null
        setLoading(false)
      }
    }
  }

  async function downloadCurrentVideo(): Promise<void> {
    if (isSearchCancelling || !videoData?.url || !selectedFormatState) return
    await startDownload(videoData.url, selectedFormatState)
  }

  async function cancelDownloadFlow(): Promise<boolean> {
    if (isSearchCancelling) return false
    const currentSearch = searchOperation
    currentSearch?.controller.abort()
    if (currentSearch) setSearchCancelling(true)
    if (!await cancelActiveDownload()) {
      if (currentSearch && searchOperation === currentSearch) setSearchCancelling(false)
      setLoading(false)
      return false
    }
    if (currentSearch) {
      try {
        await cancelDownloadTask(currentSearch.id)
      } catch {
        if (searchOperation === currentSearch) {
          setSearchCancelling(false)
          setLoading(false)
          setInfoError('Не удалось отменить скачивание. Повторите попытку.')
        }
        return false
      }
      if (searchOperation === currentSearch) {
        searchOperation = null
        setInfoError(null)
      }
      setLoading(false)
      setSearchCancelling(false)
    } else {
      setLoading(false)
    }
    return true
  }

  async function resetSearch(): Promise<void> {
    if (!await cancelDownloadFlow()) return
    resetDownloadSnapshot()
    setSearchQuery('')
    setSelectedFormat(null)
    setVideoData(null)
    rememberedVideoData = null
    setInfoError(null)
    setLoading(false)
  }

  const downloadTask: MediaTask | null = download.task
  const isDownloadRunning = download.isDownloadRunning
  const isDownloadBusy = download.isDownloadBusy
  const isCancelling = download.isCancelling || isSearchCancelling

  return {
    searchQuery: searchQueryState,
    setSearchQuery,
    selectedFormat: selectedFormatState,
    setSelectedFormat,
    videoData,
    downloadTask,
    isLoading,
    isDownloadRunning,
    isDownloadBusy,
    isCancelling,
    infoError,
    downloadError: download.downloadError,
    fetchVideo,
    downloadCurrentVideo,
    cancelDownloadFlow,
    resetSearch
  }
}
