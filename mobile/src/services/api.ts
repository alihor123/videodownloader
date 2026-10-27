import * as Device from 'expo-device'

const API_URL = 'https://videoloader.a4dev.ru/api'
export const NETWORK_ERROR_MESSAGE = 'Нет соединения с сервисом. Проверьте интернет.'

export class ApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message)
    this.name = 'ApiError'
  }
}

export class ApiAbortError extends ApiError {
  constructor(message = 'Операция отменена') {
    super(message, 499)
    this.name = 'ApiAbortError'
  }
}

export class Api {
  private static readonly defaultErrors: Record<number, string> = {
    400: 'Проверьте ссылку и попробуйте ещё раз.',
    403: 'Доступ ограничен.',
    404: 'Задача не найдена. Запустите скачивание заново.',
    408: 'Сервис не ответил. Попробуйте ещё раз.',
    409: 'Задача уже изменилась. Запустите скачивание заново.',
    413: 'Ссылка слишком длинная.',
    422: 'Проверьте ссылку и попробуйте ещё раз.',
    429: 'Слишком много попыток. Попробуйте через минуту.',
    500: 'Ошибка сервиса. Попробуйте позже.',
    503: 'Сервис занят. Попробуйте через минуту.',
    504: 'Сервис не ответил. Попробуйте ещё раз.'
  }

  static get userAgent(): string {
    const model = Device.modelName?.trim() || 'unknown'
    return `a4loader/1.0 (android; ${model})`
  }

  static getErrorMessage(status: number, errors: Record<number, string> = {}, replaceErrors = false): string {
    const messages = replaceErrors ? errors : { ...Api.defaultErrors, ...errors }
    return messages[status] ?? 'Не удалось выполнить запрос. Попробуйте ещё раз.'
  }

  static async request(
    path: string,
    init: RequestInit = {},
    errors: Record<number, string> = {},
    replaceErrors = false,
    timeoutMs = 120_000,
    signal?: AbortSignal,
    preferBackendMessage = false
  ): Promise<Response> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })

    const timeout = setTimeout(abort, timeoutMs)
    try {
      const response = await fetch(`${API_URL}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': Api.userAgent,
          ...init.headers
        },
        signal: controller.signal
      })
      if (response.ok) return response

      let message = Api.getErrorMessage(response.status, errors, replaceErrors)
      if (preferBackendMessage) {
        const body: unknown = await response.json().catch(() => null)
        if (typeof body === 'object' && body !== null && 'detail' in body && typeof body.detail === 'string') {
          message = body.detail
        }
      }
      throw new ApiError(message, response.status)
    } catch (error) {
      if (error instanceof ApiError) throw error
      if (controller.signal.aborted) {
        if (signal?.aborted) throw new ApiAbortError()
        throw new ApiError(Api.getErrorMessage(408, errors, replaceErrors), 408)
      }
      if (error instanceof TypeError) throw new ApiError(NETWORK_ERROR_MESSAGE)
      throw error
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
  }

  static fetchGet(path: string, signal?: AbortSignal): Promise<Response> {
    return Api.request(path, { method: 'GET' }, {}, false, 120_000, signal)
  }

  static fetchPost(
    path: string,
    body: unknown,
    errors: Record<number, string> = {},
    signal?: AbortSignal,
    preferBackendMessage = false
  ): Promise<Response> {
    return Api.request(path, { method: 'POST', body: JSON.stringify(body) }, errors, false, 120_000, signal, preferBackendMessage)
  }

  static fetchDelete(path: string): Promise<Response> {
    return Api.request(path, { method: 'DELETE' }, {}, false, 8_000)
  }

  static get absoluteUrl(): string {
    return API_URL
  }
}
