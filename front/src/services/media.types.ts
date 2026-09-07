export type PlatformId = 'youtube' | 'rutube' | 'vk' | 'twitter' | 'tiktok' | 'instagram'

export type MediaTaskStatus =
  | 'queued'
  | 'running'
  | 'ready'
  | 'sending'
  | 'failed'
  | 'cancelled'
  | 'completed'

export interface Platform {
  id: PlatformId
  name: string
}

export interface MediaFormat {
  height: number
  label: string
  ext: 'mp4' | 'mp3'
  size: string | null
  fast: boolean
}

export interface MediaInfo {
  url: string
  title: string
  uploader: string
  duration: string
  views: string | null
  thumbnail: string | null
  platform: PlatformId
  platform_name: string
  formats: MediaFormat[]
}

export interface MediaTask {
  task_id: string
  status: MediaTaskStatus
  stage?: string
  message?: string | null
  progress?: number | null
  error?: string | null
  error_code?: number | null
  download_url?: string | null
}

export interface Operation {
  id: string
  controller: AbortController
}
