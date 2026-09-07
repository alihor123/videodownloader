export const NETWORK_ERROR_MESSAGE =
  'Не удалось связаться с сервером. Проверьте интернет-соединение или попробуйте позже.'

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
    400: 'Не удалось выполнить запрос. Проверьте данные и попробуйте снова.',
    403: 'Недостаточно прав для выполнения этого действия.',
    404: 'Запрошенные данные не найдены.',
    408: 'Сервер не ответил вовремя. Попробуйте позже.',
    409: 'Данные уже изменились или конфликтуют с текущим состоянием.',
    413: 'Объём отправляемых данных слишком большой.',
    422: 'Не удалось обработать отправленные данные.',
    429: 'Слишком много запросов. Попробуйте немного позже.',
    500: 'На сервере произошла ошибка. Попробуйте позже.',
    503: 'Сервис временно недоступен. Попробуйте позже.',
    504: 'Сервер не ответил вовремя. Попробуйте позже.',
  }

  static getErrorMessage(status: number, errors: ErrorMessages = {}, replaceErrors = false): string {
    const messages = replaceErrors ? errors : { ...Api.defaultErrors, ...errors }
    return messages[status] ?? 'Не удалось выполнить запрос. Попробуйте позже.'
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
