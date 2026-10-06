# План для Claude Code: интеграция CRM агентства (duckcrm.one) с Pin Bridge

Этот документ отдаётся Claude Code (или разработчику) в **проекте CRM-платформы duckcrm.one**.
Код у всех агентств один, но у каждого агентства своё развёртывание со своей базой и своим
поддоменом: `morelli-realty.duckcrm.one`, `nova-caribbean.duckcrm.one` и так далее. Документ
самодостаточен: всё, что нужно знать о Pin Bridge, описано здесь. Сам сервер Pin Bridge менять
не нужно.

> Как использовать: скопируйте файл в репозиторий CRM (например, `docs/pin-bridge-plan.md`) и
> попросите Claude Code: «Реализуй интеграцию по docs/pin-bridge-plan.md». Стек ниже указан как
> Next.js + Supabase; если в CRM другой стек, сохраните ту же структуру (таблицы, серверная
> библиотека, маршруты, мастер). Подробные контракты API лежат в репозитории Pin Bridge:
> `docs/agency-onboarding.md`, `agency-api-auth.md`, `agency-api-connections.md`,
> `agency-api-listings.md`, `agency-api-publishing.md`, `agency-api-webhooks.md`.

## Цель

В настройках CRM агентства есть раздел «Pin.tt». Администратор агентства:

1. нажимает «Подключить Pin Bridge», и CRM сама регистрирует агентство в бридже, без кодов и
   ключей вручную;
2. добавляет свои номера телефона Pin (только Тринидад и Тобаго) и вводит код из SMS;
3. публикует объявления из CRM на pin.tt одной кнопкой; статусы модерации и оплаты приходят
   обратно через webhook.

Все запросы к Pin идут **через Pin Bridge** (`https://bridge.duckcrm.one`): CRM никогда не
обращается к pin.tt напрямую. После подключения номера CRM получает собственную копию
Pin-учётных данных (`device_key` и `token`) и хранит её зашифрованной.

```
[1] «Подключить» → POST /api/pin-bridge/enroll
        CRM отдаёт /.well-known/pin-bridge-enroll = sha256(client_request_id)
        ─▶ Bridge POST /v1/platform/agencies (подпись секретом платформы)
        ◀─ api_key, signing_secret, webhook.signing_secret → шифруем → БД
        ─▶ POST /v1/webhooks/test (проверка webhook)
[2] телефон → POST /api/pin-bridge/connections ─▶ Bridge POST /v1/connections (SMS)
    код     → POST /api/pin-bridge/connections/{id}/confirm ─▶ Bridge .../confirm
        ◀─ status: active + pin_credentials {device_key, token} (один раз) → шифруем → БД
[3] GET /api/pin-bridge/status ─▶ Bridge GET /v1/me → чек-лист → «Готово»
[4] объявление → PUT /v1/connections/{id}/listings/{external_id} → 202
        ◀─ webhook listing.synced / status_changed / awaiting_payment / failed
```

## Константы и окружение

Переменные развёртывания (только сервер, без префикса `NEXT_PUBLIC_`):

| Переменная                   | Значение                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `PIN_BRIDGE_URL`             | Необязательная. По умолчанию `https://bridge.duckcrm.one`. Переопределяется только для тестов.            |
| `PIN_BRIDGE_PLATFORM_SECRET` | Общий секрет платформы, тот же, что `PLATFORM_SIGNING_SECRET` на бридже. Одинаков во всех развёртываниях. |
| `AGENCY_SLUG`                | Поддомен агентства: `morelli-realty` для `morelli-realty.duckcrm.one`. `a-z 0-9 -`, 2–31 символ.          |
| `AGENCY_NAME`                | Название агентства, например `Morelli Realty`.                                                            |
| `SITE_URL`                   | `https://<AGENCY_SLUG>.duckcrm.one`, без завершающего `/`.                                                |
| `PIN_BRIDGE_ENC_KEY`         | 32 байта в base64 (`openssl rand -base64 32`), свой в каждом развёртывании. Шифрует секреты в БД.         |

`SUPABASE_SERVICE_ROLE_KEY` и `NEXT_PUBLIC_SUPABASE_URL`, скорее всего, уже есть.

При старте проверить: `AGENCY_SLUG` совпадает с `/^[a-z0-9][a-z0-9-]{1,30}$/`, а `SITE_URL` равен
`https://${AGENCY_SLUG}.duckcrm.one`. Иначе бридж откажет в подключении (`domain_not_verified` или
`invalid_webhook_url`).

Все route handlers работают с `export const runtime = 'nodejs'`, потому что нужен `node:crypto`.

## Правила безопасности (обязательны)

1. `PIN_BRIDGE_PLATFORM_SECRET`, API-ключ, signing secret, webhook secret и Pin-учётные данные
   (`device_key`, `token`) никогда не попадают в браузер, в логи и в ответы API CRM.
2. В БД секреты хранятся зашифрованными: AES-256-GCM, ключ `PIN_BRIDGE_ENC_KEY`, случайный IV на
   каждую запись, имя колонки в качестве AAD.
3. Таблицы Pin Bridge: RLS включён, политик нет. Доступ только с сервера через service role.
4. Все маршруты `/api/pin-bridge/*`, кроме `webhook` и `/.well-known/pin-bridge-enroll`, доступны
   только залогиненному администратору агентства (используйте проверку роли, которая уже есть в
   CRM).
5. Webhook принимается только с верной подписью и свежим timestamp (±5 минут).
6. Pin-учётные данные агентства используются только как резервная копия. Публикация и
   справочники идут через бридж; заходить в Pin этим номером в обход бриджа нельзя: Pin может
   отозвать токен, и публикация встанет на паузу.

## 1. Миграция БД

`supabase/migrations/<timestamp>_pin_bridge.sql`:

```sql
-- Одна строка: подключение этого агентства к Pin Bridge.
create table public.pin_bridge_account (
  id boolean primary key default true check (id),
  status text not null check (status in ('enrolling', 'connected')),
  -- Пока идёт подключение: чтобы отдать доказательство домена и безопасно повторить запрос.
  client_request_id text,
  enrolling_since timestamptz,
  agency_id uuid,
  agency_slug text,
  key_prefix text,
  api_key_enc text,
  signing_secret_enc text,
  webhook_secret_enc text,
  connected_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Номера Pin агентства.
create table public.pin_bridge_connections (
  id uuid primary key,              -- id подключения в Pin Bridge
  phone text not null,              -- E.164, например +18687234567
  display_name text,                -- имя, которое видят покупатели
  status text not null,             -- pending_code | active | reauth_required | disabled
  -- Собственная копия Pin-учётных данных (из confirm, один раз), зашифрованная.
  pin_device_key_enc text,
  pin_token_enc text,
  pin_credentials_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Состояние публикации каждого объявления CRM на Pin.
create table public.pin_bridge_listings (
  external_id text primary key,     -- id объявления в CRM
  connection_id uuid not null,      -- под каким номером опубликовано
  desired_state text,               -- active | inactive | removed
  sync_state text,                  -- queued | processing | synced | failed
  pin_item_id text,
  pin_status text,                  -- published | on_moderation | hidden | rejected | blocked
  live boolean,
  not_paid boolean,
  moderator_comment text,
  warnings jsonb,
  last_error jsonb,
  version integer not null default 0,
  updated_at timestamptz not null default now()
);

-- Дедупликация webhook: доставка «как минимум один раз».
create table public.pin_bridge_events (
  id uuid primary key,
  type text not null,
  received_at timestamptz not null default now()
);

alter table public.pin_bridge_account enable row level security;
alter table public.pin_bridge_connections enable row level security;
alter table public.pin_bridge_listings enable row level security;
alter table public.pin_bridge_events enable row level security;
-- Политик нет: anon и authenticated не видят ничего, service role видит всё.
```

## 2. Серверная библиотека `lib/pin-bridge/`

Каждый файл начинается с `import 'server-only'`.

### `config.ts`

```ts
export const PIN_BRIDGE_URL = (process.env.PIN_BRIDGE_URL ?? 'https://bridge.duckcrm.one').replace(
  /\/$/,
  '',
);
export const AGENCY_SLUG = required('AGENCY_SLUG');
export const AGENCY_NAME = required('AGENCY_NAME');
export const SITE_URL = required('SITE_URL').replace(/\/$/, '');
export const WEBHOOK_URL = `${SITE_URL}/api/pin-bridge/webhook`;
```

### `crypto.ts`: шифрование секретов

- `encrypt(plain: string, column: string): string` возвращает base64(`iv(12) | tag(16) | ciphertext`).
  Шифр `aes-256-gcm`, ключ `Buffer.from(PIN_BRIDGE_ENC_KEY, 'base64')` длиной ровно 32 байта
  (иначе ошибка при старте). `setAAD(Buffer.from(column))`.
- `decrypt(enc: string, column: string): string`.

### `signing.ts`: подпись запросов и проверка webhook (только `node:crypto`)

**Подпись запроса к Bridge.** Каждый запрос агентства несёт 4 заголовка:

```
Authorization: Bearer <api_key>
X-Timestamp:   <unix-секунды>
X-Nonce:       <32 hex, новый на каждый запрос>
X-Signature:   v1=<hex HMAC-SHA256(signing_secret, canonical)>
```

Запрос платформы (`POST /v1/platform/agencies`) подписывается **так же**, но секретом
`PIN_BRIDGE_PLATFORM_SECRET`, и без заголовка `Authorization`.

Строка `canonical` состоит из 5 строк, соединённых `\n`, без завершающего перевода строки:

```
<X-Timestamp>
<X-Nonce>
<METHOD в верхнем регистре>
<path с query, ровно как отправлен, например /v1/connections или /v1/webhooks/deliveries?limit=5>
<hex SHA-256 сырого тела; для пустого тела: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855>
```

JSON сериализуется **один раз**: подписывается и отправляется одна и та же строка.

Тестовый вектор (обязателен в unit-тесте):

```
secret    = test-signing-secret
timestamp = 1791196448
nonce     = 0123456789abcdef0123456789abcdef
method    = POST
path      = /v1/connections
body      = {"phone":"+1 868 723 4567","display_name":"John Doe"}
sha256    = f0456e8d75845cbc5905baae0b312e6da1996d5da64bfd3042d6a0f6e29a2b46
signature = v1=bce1a7aeb8a8e42aad28a7e7ef2fbd059f40f6146c5e725a6f2362d4d53e2671
```

**Проверка webhook.** Заголовок имеет вид `X-PinBridge-Signature: t=<unix>,v1=<hex HMAC-SHA256(webhook_secret, "<t>.<сырое тело>")>`.
Сравнение делается через `timingSafeEqual`. Если `|now - t| > 300`, запрос отклоняется. Подпись
считается по **сырому** телу: `await req.text()`, а не по `req.json()`.

Тестовый вектор:

```
secret = test-webhook-secret
body   = {"id":"6f1c0000-0000-4000-8000-000000000001","type":"ping","created_at":"2026-10-06T12:00:00.000Z","data":{"agency":{"id":"a1","slug":"duck"}}}
header = t=1791196448,v1=c2ae30a83cda508856f345f4d24dfe697c0e07f14c8d5561fe1e2ba69dfcb046
```

### `store.ts`: работа с БД через service role

- `getAccount()` возвращает строку `pin_bridge_account` или `null`.
- `startEnrolling()`: если есть строка `enrolling` моложе 50 минут, вернуть её
  `client_request_id`; иначе создать новый (`randomBytes(16).toString('hex')`) и сохранить со
  статусом `enrolling`.
- `saveConnected({agency, keyPrefix, apiKey, signingSecret, webhookSecret})` очищает
  `client_request_id` и ставит `connected`.
- `credentials()` возвращает расшифрованные `{ apiKey, signingSecret, webhookSecret }`. Если
  агентство не подключено, бросает ошибку.
- `upsertConnection(view)`; `savePinCredentials(connectionId, {device_key, token})` шифрует
  колонками `pin_device_key_enc` и `pin_token_enc`.
- `upsertListing(view)`: обновлять только если `version >= текущей`.
- `recordEvent(id, type): boolean` делает `insert … on conflict do nothing`. Возвращает `false`,
  если событие уже было.

### `client.ts`: вызовы Bridge

- `pinBridge<T>(method, path, body?, opts?)` подписывает запрос кредами из `credentials()` и
  делает `fetch(PIN_BRIDGE_URL + path)` с таймаутом 15 с. `opts.idempotencyKey` уходит
  заголовком `Idempotency-Key`.
  - Возвращает `{ status, data }`.
  - Ошибки Bridge имеют вид `{ error: { code, message, details?, request_id } }`. Их нужно
    пробрасывать в UI (код, сообщение, `Retry-After`), но без секретов.
- `enrollPlatform(clientRequestId)` отправляет `POST /v1/platform/agencies`, подписанный секретом
  платформы.

## 3. Подключение агентства: `POST /v1/platform/agencies`

### Доказательство домена: `GET /.well-known/pin-bridge-enroll`

Секрет платформы есть во всех развёртываниях, поэтому бридж проверяет, что запрос пришёл именно
с поддомена этого агентства: перед ответом он сам открывает
`https://<AGENCY_SLUG>.duckcrm.one/.well-known/pin-bridge-enroll`.

Маршрут (публичный, `app/.well-known/pin-bridge-enroll/route.ts`):

- если `pin_bridge_account.status = 'enrolling'` и есть `client_request_id`: ответ `200`,
  `content-type: text/plain`, тело `sha256(client_request_id)` в hex;
- иначе `404`.

Без редиректов: бридж их не выполняет. Если в CRM есть middleware авторизации или редирект на
`www`/логин, исключите этот путь.

### Запрос

```json
{
  "slug": "morelli-realty",
  "name": "Morelli Realty",
  "client_request_id": "<32 hex>",
  "webhook_url": "https://morelli-realty.duckcrm.one/api/pin-bridge/webhook"
}
```

`201`:

```json
{
  "agency": { "id": "…", "slug": "morelli-realty", "name": "Morelli Realty" },
  "api_key": "pb_…",
  "signing_secret": "…",
  "key_prefix": "pb_…",
  "webhook": { "url": "…", "signing_secret": "…", "events": [], "enabled": true },
  "retried": false
}
```

| Ответ                     | Что делать                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 201                       | Зашифровать и сохранить ключи (`saveConnected`), затем `POST /v1/webhooks/test`.                                                                         |
| 403 `forbidden`           | Агентство приостановлено на бридже.                                                                                                                      |
| 409 `agency_exists`       | Slug занят агентством, созданным не платформой (вручную или по инвайту). Для агентств платформы не возникает.                                            |
| 422 `domain_not_verified` | Бридж не увидел правильный hash. Показать `details.reason` и `details.url`: проверить, что маршрут `/.well-known` отвечает без авторизации и редиректов. |
| 422 `invalid_webhook_url` | `webhook_url` не на `https://<slug>.duckcrm.one/`. Проверить `SITE_URL`.                                                                                 |
| 401 `unauthorized`        | Неверный `PIN_BRIDGE_PLATFORM_SECRET` или часы сервера ушли больше чем на 5 минут.                                                                       |
| 404                       | На бридже не включено подключение платформой (`PLATFORM_SIGNING_SECRET` не задан).                                                                       |
| 429                       | Подождать `Retry-After` секунд.                                                                                                                          |
| таймаут, 5xx, обрыв       | Просто нажать «Подключить» ещё раз. Bridge вернёт `201` с `"retried": true` и новыми ключами того же агентства, старые перестают работать.               |

## 4. Номера Pin (подписанные запросы)

| Запрос                                       | Ответ                                                                                                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/connections {phone, display_name}` | `201` `{id, phone, display_name, status:"pending_code", resend_after_seconds, confirm_attempts_left, sms_sent}`; если номер уже `active`, то `200` и `sms_sent:false` |
| `POST /v1/connections/{id}/confirm {code}`   | `200` `{…, status:"active", pin_credentials:{device_key, token}}`; `pin_credentials` только в вызове, который активировал номер                                       |
| `POST /v1/connections/{id}/resend`           | Новый код, счётчик ошибок сбрасывается.                                                                                                                               |
| `GET /v1/connections`                        | Список подключений.                                                                                                                                                   |
| `DELETE /v1/connections/{id}`                | Отключить номер. Бридж забывает его Pin-токен.                                                                                                                        |

Под капотом бридж выполняет три шага Pin: создаёт `Device-Api-Key`, запрашивает SMS
(`phone_verify`) и обменивает код на токен.

`pin_credentials` сразу сохранить через `savePinCredentials`. Если ответ потерялся, повторный
`confirm` их уже не вернёт: это нормально, публикация от них не зависит.

Ошибки, которые нужно показать понятным текстом:

- `422 invalid_phone` — номер не Тринидада и Тобаго;
- `422 invalid_code` — неверный код, в `details.confirm_attempts_left` остаток попыток;
- `429 sms_rate_limited` — ждать `Retry-After` (Pin: не больше 5 SMS на номер за 10 минут);
- `429 sms_code_attempts_exceeded` — запросить новый код;
- `409 connection_busy` — повторить через секунду;
- `503 pin_unavailable`.

Номера принимаются в любом формате (`+1 868 723 4567`, `(868) 723-4567`, `723-4567`).

**`reauth_required`.** Если Pin разлогинил аккаунт, бридж присылает webhook
`connection.reauth_required` и ставит публикацию этого номера на паузу. CRM показывает кнопку
«Переподключить», которая снова проходит `POST /v1/connections` → SMS → `confirm` для того же
номера и сохраняет новые `pin_credentials`. Отложенные объявления уходят сами.

## 5. `GET /v1/me`: чек-лист

```json
{
  "agency": { "id": "…", "slug": "morelli-realty", "name": "Morelli Realty" },
  "api_key": { "prefix": "pb_…", "scopes": ["*"] },
  "setup": {
    "webhook": {
      "url": "…",
      "enabled": true,
      "last_delivery": {
        "type": "ping",
        "status": "delivered",
        "last_status": 200,
        "last_error": null
      }
    },
    "connections": { "active": 1, "pending_code": 0, "reauth_required": 0 },
    "dictionaries_ready": true
  }
}
```

Всё готово, когда выполнены три условия: `setup.webhook.last_delivery.status === 'delivered'`,
`setup.connections.active >= 1` и `setup.dictionaries_ready === true`.

## 6. Route handlers `app/api/pin-bridge/…`

Все обработчики, кроме `webhook`, сначала вызывают `requireAgencyAdmin()` (обёртка над проверкой
роли, которая уже есть в CRM). При неудаче отвечают `401` или `403`.

| Маршрут                                      | Что делает                                                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST enroll`                                | `startEnrolling()` → `enrollPlatform()`; при сетевой ошибке один раз сразу повторить с тем же id. На `201`: `saveConnected`, затем `POST /v1/webhooks/test`. Вернуть `{agency:{slug,name}}` без ключей. |
| `GET status`                                 | Если не подключено: `{connected:false}`. Иначе проксировать `GET /v1/me` и добавить локальные `pin_bridge_connections` (без секретов).                                                                  |
| `POST connections` `{phone, display_name}`   | Прокси к `POST /v1/connections` и `upsertConnection`.                                                                                                                                                   |
| `POST connections/[id]/confirm` `{code}`     | Прокси; `upsertConnection`; если в ответе есть `pin_credentials`, `savePinCredentials` и **вырезать** их из ответа браузеру.                                                                            |
| `POST connections/[id]/resend`               | Прокси.                                                                                                                                                                                                 |
| `DELETE connections/[id]`                    | Прокси к `DELETE /v1/connections/{id}`, очистить `pin_*_enc` у номера.                                                                                                                                  |
| `GET dictionaries/...`                       | Прокси к справочникам (раздел 8) с кэшем на 1 час.                                                                                                                                                      |
| `POST listings/[externalId]/publish` и т. д. | Раздел 8.                                                                                                                                                                                               |
| `POST webhook` (публичный)                   | Описан ниже.                                                                                                                                                                                            |

Обработка `webhook`:

1. Прочитать сырое тело через `await req.text()`.
2. Проверить `X-PinBridge-Signature` секретом из `credentials().webhookSecret`. При неудаче
   ответить `401`.
3. Распарсить JSON и вызвать `recordEvent(id, type)`. Если событие уже было, сразу ответить `200`.
4. Обработать событие по `type`:
   - `listing.synced`, `listing.failed`, `listing.status_changed`, `listing.awaiting_payment` →
     `upsertListing(data.listing)`; для `failed`, `rejected` и `awaiting_payment` показать
     уведомление агенту;
   - `connection.connected`, `connection.reauth_required` → `upsertConnection(data.connection)`;
   - `ping` → ничего.
5. Ответить `200` быстро, в пределах 10 с. Тяжёлую работу не выполнять синхронно.

## 7. UI: раздел «Pin.tt» в настройках

Клиентский компонент `components/pin-bridge/PinSettings.tsx` ходит только в `/api/pin-bridge/*`.

1. **Не подключено:** кнопка «Подключить Pin Bridge». Пока идёт запрос, индикатор. Ошибки по
   `error.code` (раздел 3).
2. **Номера:** список номеров со статусом. «Добавить номер»: поля телефона и имени (имя видят
   покупатели) → «Отправить SMS» → поле кода. Кнопка «Отправить снова» неактивна, пока идёт
   таймер `resend_after_seconds`; показывать остаток попыток.
3. **Чек-лист** из `GET status`: агентство подключено ✓; webhook доставлен ✓ (до доставки `ping`
   опрашивать каждые 3 с, не дольше 60 с); номер Pin подключён ✓; справочники ✓. Когда всё
   отмечено — «Готово».
4. После перезагрузки страницы раздел открывается в нужном состоянии по `GET status`.
5. У номера `reauth_required` показывать предупреждение и кнопку «Переподключить».

## 8. Справочники и публикация объявлений

Полный формат объявления: `agency-api-listings.md`; поведение публикации:
`agency-api-publishing.md` (репозиторий Pin Bridge).

**Справочники** (кэшировать на 1 час, обновлять при ошибке валидации):

- `GET /v1/dictionaries/categories` — категории (`residential_sale`, `residential_rent`);
- `GET /v1/dictionaries/categories/{category}/attributes` — атрибуты: `slug`, `type`
  (`select`, `multiselect`, `number`, `text`), `required`, допустимые `values`;
- `GET /v1/dictionaries/regions` и `GET /v1/dictionaries/regions/{region}/districts`.

**Маппинг объявления CRM в документ Pin Bridge** (`lib/pin-bridge/listing-mapper.ts`):

```json
{
  "category": "residential_rent",
  "title": "2-bedroom apartment in Valsayn",
  "description": "Fully furnished, A/C, gated community, parking.",
  "price": 3500,
  "currency": "TTD",
  "region": "central",
  "district_ids": [1701],
  "images": ["https://cdn…/8842/1.jpg"],
  "contact": { "name": "John Doe", "hide_phone": false },
  "link": "https://morelli-realty.duckcrm.one/listings/8842",
  "attributes": { "type": "Apartment", "bedrooms": 3, "number-of-bathrooms": 2 }
}
```

- `external_id` = id объявления в CRM (1–64 символа `A-Z a-z 0-9 . _ -`).
- Значения атрибутов — читаемые (`"bedrooms": 3`), бридж сам переводит их в id Pin.
- Фото — публичные HTTPS-URL JPEG/PNG; при замене фото менять URL.
- Неизвестные поля отклоняются, поэтому маппер строгий и покрыт unit-тестом.

**Под каким номером публиковать.** У объявления в CRM есть поле «Номер Pin»
(`pin_connection_id`), по умолчанию — номер ответственного агента или первый активный номер
агентства.

**Операции** (маршруты CRM → Bridge):

| CRM                                   | Bridge                                                                                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| «Проверить» перед публикацией         | `POST /v1/listings/validate` → ошибки по полям в `details.errors`.                                                                                                                       |
| «Опубликовать» / сохранение изменений | `PUT /v1/connections/{id}/listings/{external_id}` с полным документом, `Idempotency-Key: <external_id>:<версия в CRM>`. `202` — в очереди, `200` — без изменений, `422 invalid_listing`. |
| «Скрыть» / «Показать»                 | `POST …/deactivate` / `POST …/activate`.                                                                                                                                                 |
| «Снять с Pin» / удаление в CRM        | `DELETE /v1/connections/{id}/listings/{external_id}`.                                                                                                                                    |
| Статус в карточке объявления          | Из `pin_bridge_listings` (webhook); кнопка «Обновить» — `GET …/listings/{external_id}`.                                                                                                  |

Публикация асинхронная: ответ приходит за миллисекунды, а бридж в фоне загружает фото, создаёт
объявление на Pin и сообщает результат через webhook. В карточке объявления показывать
`sync_state`, `pin_status`, `moderator_comment`, `not_paid` («ожидает оплаты на Pin»),
`last_error`.

## 9. Тесты и критерии готовности

**Unit-тесты (vitest или jest, что принято в проекте):**

- `signing.ts` проходит оба тестовых вектора выше; подпись платформы — тот же алгоритм с другим
  секретом;
- `crypto.ts`: шифрование туда и обратно; другая колонка (AAD) или другой ключ дают ошибку;
- `/.well-known/pin-bridge-enroll`: `200` и верный hash в состоянии `enrolling`, иначе `404`;
- webhook: неверная подпись → 401; старый `t` → 401; повтор того же `id` обрабатывается один раз;
- `confirm`: `pin_credentials` сохраняются зашифрованными и не попадают в ответ браузеру;
- `listing-mapper.ts`: объявление CRM → документ, который проходит `POST /v1/listings/validate`.

**Ручная проверка на развёртывании `test-agency.duckcrm.one`:**

1. «Подключить Pin Bridge» → в БД `pin_bridge_account` со статусом `connected` и
   зашифрованными полями; в ответах CRM ключей нет; в чек-листе webhook ✓.
2. Очистить `pin_bridge_account` (как будто ключи потеряны) и снова «Подключить» → то же
   агентство, `retried: true`, новые ключи; старые ключи отвечают `401`.
3. Номер TT → SMS → код → номер ✓; в `pin_bridge_connections` заполнены `pin_*_enc`; пришёл
   webhook `connection.connected`.
4. Опубликовать объявление → `202`, затем webhook `listing.synced`; объявление видно на pin.tt.
5. Скрыть, показать, снять → соответствующие webhook-события и статус в карточке.
6. Временно неверный `PIN_BRIDGE_URL` при подключении и повтор → то же агентство, `retried: true`.

**Готово, когда:** администратор агентства проходит путь от «Подключить» до опубликованного
объявления без ручной работы с ключами, секретов нет ни в браузере, ни в логах, а webhook-события
обновляют статусы в CRM.
