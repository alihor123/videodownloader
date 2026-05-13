export const NETWORK_ERROR_MESSAGE =
  "Не удалось связаться с сервером. Проверьте соединение с интернетом или попробуйте позже"

// Таймаут фронта НЕ должен быть больше, чем у Nginx.
const REQUEST_TIMEOUT_MS = 120_000

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

export class ApiAbortError extends ApiError {
  constructor(message = "Операция отменена") {
    super(message, 499)
    this.name = "ApiAbortError"
  }
}

export class Api {
  static defaultErrors = {
    400: "Не удалось выполнить запрос. Проверьте данные и попробуйте снова",
    403: "Недостаточно прав для выполнения этого действия",
    404: "Запрошенные данные не найдены",
    408: "Сервер не ответил вовремя. Попробуйте позже",
    409: "Данные уже изменились или конфликтуют с текущим состоянием",
    413: "Объем отправляемых данных слишком большой",
    422: "Не удалось обработать отправленные данные",
    429: "Слишком много запросов. Попробуйте немного позже",
    500: "На сервере произошла ошибка. Попробуйте позже",
    503: "Сервис временно недоступен. Попробуйте позже",
    504: "Сервер не ответил вовремя. Попробуйте позже",
  }

  static getErrorMessage(status, errors = {}, errorsReplace = false) {
    const errorMessages = errorsReplace ? errors : { ...Api.defaultErrors, ...errors }
    return errorMessages[status] ?? "Не удалось выполнить запрос. Попробуйте позже"
  }

  static getHeaders() {
    return {
      "Content-Type": "application/json",
    }
  }

  static async fetchWithTimeout(
    url,
    init,
    timeoutMs = REQUEST_TIMEOUT_MS,
    externalSignal
  ) {
    // 1) Создаем внутренний контроллер для текущего fetch-запроса.
    // Именно его signal передается в fetch ниже.
    const requestController = new AbortController()

    // 2) Универсальная функция отмены текущего запроса.
    // Ее можно вызвать и из таймера, и из внешнего сигнала отмены.
    const relayAbort = () => requestController.abort()

    if (externalSignal) {
      // 3) Если внешний сигнал уже был отменен ДО запуска fetchWithTimeout,
      // сразу отменяем внутренний запрос.
      if (externalSignal.aborted) {
        relayAbort()
      } else {
        // 4) Иначе подписываемся на будущую отмену.
        // Когда внешний сигнал получит abort(), вызовется relayAbort() и оборвет fetch.
        // once:true означает "вызвать обработчик максимум один раз".
        externalSignal.addEventListener("abort", relayAbort, { once: true })
      }
    }

    // 5) Ставим таймер как второй источник отмены.
    // Если ответ не пришел за timeoutMs, таймер вызовет relayAbort().
    const timeoutId = setTimeout(relayAbort, timeoutMs)

    try {
      // 6) Запускаем fetch с внутренним signal.
      // Отменить этот fetch можно через requestController.abort().
      return await fetch(url, {
        ...init,
        signal: requestController.signal,
      })
    } finally {
      // 7) Любой исход (успех/ошибка/отмена): обязательно чистим таймер.
      clearTimeout(timeoutId)

      if (externalSignal) {
        // 8) Снимаем подписку на внешний сигнал.
        // Это защита от "висячих" обработчиков: запрос мог завершиться
        // раньше, чем произошел abort у внешнего сигнала.
        externalSignal.removeEventListener("abort", relayAbort)
      }
    }
  }

  static async request(
    path,
    init,
    errors = {},
    errorsReplace = false,
    timeoutMs = REQUEST_TIMEOUT_MS,
    signal
  ) {
    try {
      // 1) Выполняем HTTP-запрос через общий helper с таймаутом и abort-логикой.
      const response = await Api.fetchWithTimeout(
        `/api${path}`,
        {
          ...init,
          headers: Api.getHeaders(),
        },
        timeoutMs,
        signal
      )

      // 2) Нормализуем HTTP-ошибки (4xx/5xx) в единый ApiError.
      if (!response.ok) {
        throw new ApiError(
          Api.getErrorMessage(response.status, errors, errorsReplace),
          response.status
        )
      }

      // 3) Успех: возвращаем raw Response (парсинг json делает вызывающий код).
      return response
    } catch (error) {
      // 4) Если ошибка уже нашего формата — просто пробрасываем дальше.
      if (error instanceof ApiError) {
        throw error
      }

      // 5) TypeError от fetch обычно означает сетевую проблему
      // (нет интернета/DNS/CORS/разрыв соединения и т.п.).
      if (error instanceof TypeError) {
        throw new ApiError(NETWORK_ERROR_MESSAGE)
      }

      if (error?.name === "AbortError") {
        // 6) AbortError может быть двух типов:
        //    а) ручная отмена из UI (signal.aborted === true)
        //    б) таймаутный abort (таймер вызвал relayAbort, а внешний signal не отменен)
        // Для UI нам важно различать их поведением.
        if (signal?.aborted) {
          // 6а) Ручная отмена: специальный тип ошибки, чтобы экран мог тихо завершить сценарий.
          throw new ApiAbortError()
        }
        // 6б) Таймаут: показываем пользователю понятную 408-ошибку.
        throw new ApiError(Api.getErrorMessage(408, errors, errorsReplace), 408)
      }

      // 7) Все остальные неизвестные ошибки отдаем выше без искажений.
      throw error
    }
  }

  static fetchGet(path, errors = {}, errorsReplace = false, timeoutMs = REQUEST_TIMEOUT_MS, signal) {
    return Api.request(path, { method: "GET" }, errors, errorsReplace, timeoutMs, signal)
  }

  static fetchPost(path, body, errors = {}, errorsReplace = false, timeoutMs = REQUEST_TIMEOUT_MS, signal) {
    return Api.request(
      path,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      errors,
      errorsReplace,
      timeoutMs,
      signal
    )
  }

  static fetchDelete(path, errors = {}, errorsReplace = false, timeoutMs = REQUEST_TIMEOUT_MS, signal) {
    return Api.request(path, { method: "DELETE" }, errors, errorsReplace, timeoutMs, signal)
  }

  static fetchPut(path, body, errors = {}, errorsReplace = false, timeoutMs = REQUEST_TIMEOUT_MS, signal) {
    return Api.request(
      path,
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
      errors,
      errorsReplace,
      timeoutMs,
      signal
    )
  }
}
