export const NETWORK_ERROR_MESSAGE =
  'Нет соединения с сервисом. Проверьте интернет.'

const REQUEST_TIMEOUT_MS = 120_000

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

type ErrorMessages = Record<number, string>

export class Api {
  private static readonly defaultErrors: ErrorMessages = {
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
    504: 'Сервис не ответил. Попробуйте ещё раз.',
  }

  static getErrorMessage(status: number, errors: ErrorMessages = {}, replaceErrors = false): string {
    const messages = replaceErrors ? errors : { ...Api.defaultErrors, ...errors }
    return messages[status] ?? 'Не удалось выполнить запрос. Попробуйте ещё раз.'
  }

  private static async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController()
    const abortRequest = () => controller.abort()

    if (externalSignal?.aborted) abortRequest()
    else externalSignal?.addEventListener('abort', abortRequest, { once: true })

    const timeoutId = window.setTimeout(abortRequest, timeoutMs)
    try {
      return await fetch(url, { ...init, signal: controller.signal })
    } finally {
      window.clearTimeout(timeoutId)
      externalSignal?.removeEventListener('abort', abortRequest)
    }
  }

  static async request(
    path: string,
    init: RequestInit,
    errors: ErrorMessages = {},
    replaceErrors = false,
    timeoutMs = REQUEST_TIMEOUT_MS,
    signal?: AbortSignal,
    preferBackendMessage = false,
  ): Promise<Response> {
    try {
      const response = await Api.fetchWithTimeout(
        `/api${path}`,
        { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } },
        timeoutMs,
        signal,
      )
      if (response.ok) return response

      let message = Api.getErrorMessage(response.status, errors, replaceErrors)
      if (preferBackendMessage) {
        const body: unknown = await response.json().catch(() => null)
        if (typeof body === 'object' && body !== null && 'detail' in body && typeof body.detail === 'string') {
          message = body.detail
        }
      }
      throw new ApiError(message, response.status)
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error
      if (error instanceof TypeError) throw new ApiError(NETWORK_ERROR_MESSAGE)
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (signal?.aborted) throw new ApiAbortError()
        throw new ApiError(Api.getErrorMessage(408, errors, replaceErrors), 408)
      }
      throw error
    }
  }

  static fetchGet(path: string, signal?: AbortSignal): Promise<Response> {
    return Api.request(path, { method: 'GET' }, {}, false, REQUEST_TIMEOUT_MS, signal)
  }

  static fetchPost(
    path: string,
    body: unknown,
    errors: ErrorMessages = {},
    signal?: AbortSignal,
    preferBackendMessage = false,
  ): Promise<Response> {
    return Api.request(
      path,
      { method: 'POST', body: JSON.stringify(body) },
      errors,
      false,
      REQUEST_TIMEOUT_MS,
      signal,
      preferBackendMessage,
    )
  }
}
