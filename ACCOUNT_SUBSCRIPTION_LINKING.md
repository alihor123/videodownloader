# Аккаунты, подписки и связка Telegram с вебом

## Главная идея

Подписка не должна принадлежать напрямую Telegram ID, IP, cookie или email.

Подписка должна принадлежать внутреннему пользователю системы:

```text
user
```

А Telegram, веб-гость, email и будущие способы входа должны быть просто способами узнать этого пользователя:

```text
identity
```

Тогда один человек может пользоваться сервисом и через сайт, и через Telegram-бота, а подписка будет общей.

## Базовые сущности

### `users`

Главная внутренняя учётка.

```text
id
created_at
updated_at
```

На этом уровне неважно, откуда пришёл человек: из Telegram, из браузера, через email или как гость.

### `identities`

Способы входа и привязки к одному `user`.

```text
id
user_id
provider
external_id
created_at
last_seen_at
```

Примеры:

```text
provider=telegram
external_id=123456789
```

```text
provider=guest
external_id=browser-cookie-uuid
```

```text
provider=email
external_id=user@example.com
```

У одного `user` может быть несколько `identity`:

```text
user #42
  - telegram:123456789
  - guest:browser-cookie-uuid
  - email:user@example.com
```

### `subscriptions`

Подписка висит на `user_id`.

```text
id
user_id
status
plan
started_at
expires_at
payment_provider
payment_external_id
created_at
updated_at
```

Примеры `status`:

```text
active
expired
canceled
trial
```

Примеры `payment_provider`:

```text
yookassa
stripe
telegram
manual
```

### `link_tokens`

Одноразовые токены для связки Telegram и веба.

```text
id
token
source_user_id
target_provider
expires_at
used_at
created_at
```

Токен нужен, чтобы безопасно сказать системе:

```text
Этот Telegram-аккаунт и эта веб-учётка принадлежат одному человеку.
```

## Почему не хранить подписку на Telegram ID

Если подписка привязана только к Telegram ID, то человек не сможет нормально пользоваться ею на сайте.

Если подписка привязана только к cookie-гостю на сайте, то она потеряется при другом браузере или телефоне.

Если подписка привязана только к email, Telegram-бот не поймёт, кто перед ним, пока пользователь не свяжет Telegram с email.

Поэтому нужна центральная сущность `user`, а все внешние идентификаторы должны ссылаться на неё.

## Главный сценарий, который стоит выбрать

Самый понятный путь для старта:

1. Пользователь может начать в Telegram или на сайте.
2. В любом случае система создаёт внутренний `user`.
3. Подписка покупается для этого `user`.
4. Если пользователь хочет второй канал, он привязывает его через одноразовый код или ссылку.

Так неважно, где человек купил подписку. Если аккаунты связаны, доступ будет общий.

## Сценарий A: пользователь купил подписку на сайте и хочет Telegram

### На сайте

1. Пользователь открывает сайт.
2. Если он не зарегистрирован, создаётся guest identity:

```text
provider=guest
external_id=<uuid из cookie>
```

3. Пользователь покупает подписку.
4. Подписка сохраняется на `user_id`.
5. Пользователь нажимает "Привязать Telegram".
6. Backend создаёт `link_token`.

Пример:

```text
token=ABCD12
source_user_id=42
target_provider=telegram
expires_at=now + 10 minutes
```

7. Сайт показывает ссылку:

```text
https://t.me/your_bot?start=link_ABCD12
```

### В Telegram

1. Пользователь открывает ссылку.
2. Бот получает `/start link_ABCD12`.
3. Backend проверяет токен.
4. Backend берёт Telegram ID пользователя.
5. Создаёт identity:

```text
provider=telegram
external_id=<telegram_user_id>
user_id=42
```

Теперь Telegram-бот видит подписку пользователя `42`.

## Сценарий B: пользователь купил подписку в Telegram и хочет веб

### В Telegram

1. Пользователь пишет боту.
2. Backend создаёт или находит identity:

```text
provider=telegram
external_id=<telegram_user_id>
```

3. Если подписка покупается через Telegram, она всё равно создаётся на `user_id`.
4. Пользователь пишет `/web` или нажимает кнопку "Войти на сайте".
5. Backend создаёт `link_token`.

Пример:

```text
token=XYZ789
source_user_id=77
target_provider=guest_or_email
expires_at=now + 10 minutes
```

6. Бот отправляет ссылку:

```text
https://videoloader.a4dev.online/link/XYZ789
```

### На сайте

1. Пользователь открывает ссылку.
2. Если у него ещё нет веб-аккаунта, сайт создаёт guest identity или просит войти/register.
3. Backend проверяет `link_token`.
4. Веб identity привязывается к тому же `user_id=77`.

Теперь сайт видит подписку, которая была куплена через Telegram.

## Нужно ли заставлять всех покупать только на сайте

Можно сделать так, но это не обязательно.

### Вариант 1: все покупки только на сайте

Путь:

1. Бот говорит: "Для покупки открой сайт".
2. Пользователь переходит на сайт.
3. Покупает подписку.
4. После покупки привязывает Telegram.

Плюсы:

- проще платежная логика;
- все чеки, email, возвраты и статусы живут в одном месте;
- проще сделать личный кабинет;
- меньше разных сценариев оплаты.

Минусы:

- Telegram-сценарий становится длиннее;
- часть пользователей может отвалиться при переходе на сайт.

### Вариант 2: покупать можно и на сайте, и в Telegram

Путь:

1. Пользователь покупает там, где ему удобно.
2. Подписка всё равно создаётся на внутренний `user_id`.
3. Второй канал привязывается через link token.

Плюсы:

- удобнее пользователю;
- меньше трения в Telegram;
- бот может продавать подписку прямо в чате.

Минусы:

- сложнее платежная логика;
- нужно аккуратно обрабатывать разные payment provider;
- больше сценариев поддержки.

## Рекомендация для старта

Начать лучше с покупки на сайте.

Причина простая: сайт проще сделать центром аккаунта, оплаты и управления подпиской.

Рекомендуемый первый этап:

1. Сайт создаёт guest user через cookie.
2. Пользователь покупает подписку на сайте.
3. После оплаты сайт предлагает привязать Telegram.
4. Telegram привязывается через deep link.
5. Бот проверяет подписку по `telegram_user_id -> identity -> user -> subscription`.

Второй этап:

1. Добавить кнопку в боте "Купить подписку".
2. Сначала она ведёт на сайт.
3. Позже можно добавить оплату прямо внутри Telegram.

Так система не усложняется раньше времени, но архитектура уже готова к покупке из любого места.

## Как проверять доступ в Telegram

Когда пользователь пишет боту:

1. Бот отправляет backend `telegram_user_id`.
2. Backend ищет:

```text
identities.provider = telegram
identities.external_id = telegram_user_id
```

3. Получает `user_id`.
4. Проверяет активную подписку:

```text
subscriptions.user_id = user_id
status = active
expires_at > now
```

5. Если подписка активна, бот разрешает расширенный функционал.
6. Если подписки нет, бот предлагает купить или привязать существующий аккаунт.

## Как проверять доступ на сайте

На сайте возможны этапы:

1. Гость по cookie.
2. Явный аккаунт по email/login.
3. Привязанный Telegram.

На старте можно использовать guest cookie:

```text
guest:<uuid>
```

Позже, когда появится регистрация:

```text
email:<email>
```

Если гость потом зарегистрировался, его guest identity можно оставить привязанной к тому же `user_id`.

## Что делать, если аккаунты конфликтуют

Конфликт: Telegram уже привязан к одному `user`, а сайт пытается привязать его к другому.

Правило:

- автоматически не объединять;
- показать ошибку;
- предложить отвязать старый аккаунт или обратиться в поддержку.

Конфликт подписок: и веб-аккаунт, и Telegram-аккаунт уже имеют активные подписки.

Правило:

- автоматически не объединять;
- это риск дать доступ не тому человеку или потерять оплату;
- такие случаи лучше решать вручную или отдельным flow подтверждения.

## Rate limit и статистика

IP не должен быть главным идентификатором пользователя.

Лучше использовать общий `actor_id`:

```text
guest:<uuid>
telegram:<telegram_user_id>
user:<user_id>
ip:<ip>
```

Для rate limit:

```text
rate_limit_key = actor_id
```

Для статистики:

```text
downloads.actor_id
downloads.ip
downloads.user_agent
```

IP всё ещё полезен для диагностики и антиабуза, но подписка и лимиты должны жить на уровне пользователя или actor.

## Минимальная схема БД

```text
users
  id
  created_at
  updated_at

identities
  id
  user_id
  provider
  external_id
  created_at
  last_seen_at

subscriptions
  id
  user_id
  status
  plan
  started_at
  expires_at
  payment_provider
  payment_external_id
  created_at
  updated_at

link_tokens
  id
  token
  source_user_id
  target_provider
  expires_at
  used_at
  created_at

downloads
  id
  user_id
  actor_id
  ip
  user_agent
  video_url
  format_value
  file_ext
  created_at
```

## Минимальный план внедрения

1. Добавить таблицу `users`.
2. Добавить таблицу `identities`.
3. Добавить таблицу `subscriptions`.
4. Добавить таблицу `link_tokens`.
5. На сайте создавать guest identity через cookie.
6. В Telegram создавать telegram identity по `telegram_user_id`.
7. Подписку всегда сохранять на `user_id`.
8. Сделать link token flow для связки сайта и Telegram.
9. Rate limiter перевести с `ip` на `actor_id`.
10. В статистике хранить и `actor_id`, и `ip`.

## Итог

Лучший путь:

```text
subscription -> user
telegram/web/email/guest -> identities -> user
```

Покупку на первом этапе лучше вести через сайт, а Telegram привязывать через deep link. Позже можно добавить оплату прямо в Telegram, не меняя фундаментальную модель: подписка всё равно будет принадлежать внутреннему `user`.
