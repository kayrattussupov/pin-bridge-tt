# План: интеграционный сервер Pin Bridge (агентства → наш сервер → pin.tt)

## Context

Таска ClickUp «Set up the real estate listings integration via API» (869eyj21n). Pin.tt дал доступ к API **только с одного сервера** (прод закрыт Cloudflare: с чужих IP `POST /api/v1.6/items/device_api_key/` → 403, стенда не будет, работаем сразу на проде). Агентств будет много, у каждого свои домены и IP. Поэтому нужен посредник: **Pin Bridge**. Это единственная точка выхода к Pin с разрешённого IP, мультитенантная, с собственной аутентификацией агентств.

Выбрано: **Node.js + TypeScript**, агентства **пушат через REST API**, SMS-код **вводится в UI агентства**, а наш API проксирует его в Pin.

Что известно о Pin API из комментариев (вся логика ниже на этом построена):
- Заголовок `Device-Api-Key` нужен везде (ключ создаётся `POST /api/v1.6/items/device_api_key/` → ключ в поле `id`, а не `uuid`, как было в описании; проверено на проде 06.10). Это единственная ручка, куда пускают без него.
- Вход: `GET /users/phone_verify/?phone=&check_type=sms` (лимит 5 запросов с одного ключа за 10 мин, `end_date` = кулдаун), затем `POST /users/phone_verify/?token=1 {phone, code, check_type}` → `{status:0, token}`. Токен бессрочный, при повторном входе отдаётся тот же; сбрасывается только принудительным разлогином. Пользователь создаётся на первом успешном verify. Номера только TT (+1868), с KZ приходит ошибка «Could not determine the country by number».
- Картинки по одной: `POST /items/pics/` (multipart `img`) → `id`. jpg/png, ≤10 МБ, длинная сторона 1600px, максимум 16 штук (лишние отрезаются молча), при неудачном превью 400.
- `POST /items/` (rubric, city=регион, currency_id=1, title, description, price, images[], coordinates{latitude,longitude}, user{name,email}, external_id, item_link, attrs по slug→ключ варианта). Ещё есть `POST /items/validate_ad/`, `POST /items/<id>/`, `PATCH /items/<id>/partial_update/`, `POST /items/toggle_active/<id>/`, `POST /items/to_remove/<id>/`, `GET /items/front_my/`.
- Справочники: `tree_v2`, `rubric_form/<id>`, `all_cities`, `city_districts/<id>`. Регионы: 17 Central, 18 NE, 21 NW, 23 SW, 22 SE, 15 Tobago.
- Пост-модерация: `status` 0 опубл., 1 на проверке, 2 скрыто, 3 отклонено, 4 заблокировано (причина в `moderator_comment`). Платность отдельно, флаг `not_paid`. Успех = `status==0 && not_paid==false`. Платные рубрики: 20 (sale, 69 TT$/30д, первые 5 бесплатно), 21 (rent при цене >4000 TT$, бесплатно 4/30д).

## Архитектура

```
Agency servers ──HTTPS + API key + HMAC──▶ [Caddy/Nginx TLS, WAF, rate limit]
                                                │
                                         ┌──────▼──────┐   enqueue    ┌──────────┐
                                         │  API (Nest)  │────────────▶│  Redis    │ BullMQ
                                         └──────┬──────┘              └────┬─────┘
                                                │ read/write               │
                                          ┌─────▼─────┐             ┌──────▼──────┐
                                          │ PostgreSQL │◀───────────│  Workers    │──▶ pin.tt (whitelisted static IP)
                                          └───────────┘             │ publish /   │
                                                                    │ status-sync │──▶ Agency webhooks (HMAC-signed)
                                                                    │ dict-sync   │
                                                                    └─────────────┘
```

- Один репозиторий, один NestJS-код и два entrypoint: `api` (HTTP) и `worker` (очереди, крон). Деплой через Docker Compose на **том же сервере, IP которого в allowlist у Pin**. Если будем масштабироваться, все исходящие запросы к Pin идут через один egress (тот же хост или NAT/forward-proxy с этим IP). Модуль `PinClient` поддерживает `HTTPS_PROXY` для этого.
- **Принцип: API никогда не ходит в Pin синхронно**, кроме двух шагов подключения аккаунта (SMS), где без этого нельзя. Всё остальное идёт через очередь. Так время ответа агентству не зависит от Pin.
- Стек: NestJS + Fastify, Prisma (или Drizzle) + PostgreSQL 16, Redis 7 (AOF), BullMQ, undici (keep-alive pool к Pin), sharp (картинки), zod (валидация), pino (логи), prom-client + OpenTelemetry, Sentry.

### Структура проекта (`/home/user/pin-bridge-tt`)
```
src/
  main.api.ts, main.worker.ts
  config/            # zod-схема env, секреты
  auth/              # API-ключи агентств, HMAC-проверка, nonce-кэш
  agencies/          # агентства, ключи, webhook-эндпоинты, IP allowlist
  connections/       # аккаунты Pin (phone verify flow, токены)
  listings/          # CRUD объявлений, idempotency, state machine
  images/            # безопасная загрузка, нормализация, кэш по sha256
  pin/               # PinClient (HTTP), rate limiter, circuit breaker, error mapping
  dictionaries/      # кэш rubric/city/attrs + mapper человеко-значений → ключи Pin
  jobs/              # BullMQ процессоры: publish, update, remove, toggle, status-sync, dict-sync, webhook-delivery
  webhooks/          # outbox + подписанная доставка
  crypto/            # AES-256-GCM envelope encryption
  observability/     # метрики, трейсинг, health
prisma/schema.prisma
test/  (unit, contract с fake-pin, e2e)
docker/ docker-compose.yml, Caddyfile
docs/openapi.yaml    # контракт для агентств
```

## Модель данных (PostgreSQL)

| Таблица | Ключевые поля |
|---|---|
| `agencies` | id, name, status(active/suspended), ip_allowlist[], quotas |
| `api_keys` | id, agency_id, key_prefix, key_hash(argon2/sha256+pepper), hmac_secret_enc, scopes, last_used_at, revoked_at |
| `connections` | id, agency_id, phone_e164, pin_device_key_enc, pin_token_enc, pin_user_id, status(pending_code/active/reauth_required/disabled), sms_cooldown_until, sms_attempts_window |
| `listings` | id, agency_id, connection_id, external_id (**unique по agency+connection**), pin_item_id, rubric, payload_hash, desired_state(active/inactive/removed), sync_state(queued/processing/synced/failed), pin_status(0–4), not_paid, moderator_comment, last_error, version |
| `listing_images` | listing_id, position, source_url, sha256, pin_pic_id, status |
| `idempotency_keys` | agency_id, key, request_hash, response, expires_at (24ч) |
| `webhook_endpoints` / `webhook_outbox` | url, secret_enc, events[] / event, payload, attempts, next_attempt_at, delivered_at |
| `dictionaries` | kind(rubric_form/cities/districts/tree), key, data jsonb, fetched_at |
| `audit_log` | actor, agency_id, action, target, ip, ts (без PII в открытом виде) |

## API для агентств (v1, документ `docs/openapi.yaml`)

Аутентификация в каждом запросе: `Authorization: Bearer <api_key>` + `X-Timestamp` + `X-Nonce` + `X-Signature = HMAC-SHA256(secret, ts\nnonce\nmethod\npath\nsha256(body))`.

| Метод | Назначение | Ответ |
|---|---|---|
| `POST /v1/connections` `{phone, display_name}` | создать Device-Api-Key и отправить SMS (синхронно в Pin) | 201 `{connection_id, resend_after}` |
| `POST /v1/connections/{id}/confirm` `{code}` | подтвердить код → токен хранится у нас, **агентству не отдаётся** | 200 `{status: active}` |
| `POST /v1/connections/{id}/resend` | повторная SMS с учётом кулдауна | 200 / 429 `{retry_after}` |
| `GET/DELETE /v1/connections/{id}` | статус / отключение (стираем токен) | |
| `PUT /v1/connections/{cid}/listings/{external_id}` | upsert объявления (create или update), `Idempotency-Key` | **202** `{listing_id, sync_state: queued}` |
| `GET /v1/connections/{cid}/listings/{external_id}` | статус из нашей БД (pin_status, not_paid, moderator_comment, pin_url) | 200 |
| `GET /v1/connections/{cid}/listings?state=&cursor=` | список | 200 |
| `POST …/listings/{external_id}/deactivate` / `activate` | toggle_active | 202 |
| `DELETE …/listings/{external_id}` | to_remove | 202 |
| `POST /v1/listings/validate` | сухая проверка: наша схема + маппинг + `validate_ad` | 200 `{valid, errors[]}` |
| `GET /v1/dictionaries/{rubrics,regions,districts/{id},attributes/{rubric}}` | справочники из кэша | 200 |
| `PUT /v1/webhooks` | url + events | 200 |

Payload объявления: **каноническая схема** с понятными значениями (`bedrooms: 3`, `bathrooms: 2`, `region: "central"`, `images: [url…]`, `coordinates {lat,lng}`). `dictionaries/mapper` переводит их в ключи вариантов Pin по кэшу `rubric_form` (пример грабли из комментария: bedrooms 3 → ключ `10`). Для продвинутых есть `pin_attrs_override`. Ошибки маппинга отдаются сразу с 422 и путём к полю.

Webhook-события: `connection.reauth_required`, `listing.synced`, `listing.failed`, `listing.status_changed` (published / on_moderation / hidden / rejected / blocked), `listing.awaiting_payment`. Подпись `X-Signature` (HMAC) и `X-Event-Id` для дедупликации.

## Сценарии взаимодействия

1. **Подключение аккаунта.** API валидирует `+1868XXXXXXX` (иначе 422 до похода в Pin) → создаём **отдельный Device-Api-Key на каждое подключение** (лимит SMS считается на ключ, так подключения изолированы) → `phone_verify GET` → сохраняем `end_date` как кулдаун. На confirm делаем `POST ?token=1` → шифруем token и сохраняем. Ошибки Pin («Could not determine the country», неверный код, лимит 5/10мин) мапятся в понятные коды. Наш лимит: ≤5 confirm-попыток на connection, ≤N подключений в час на агентство (защита от SMS-флуда).
2. **Создание объявления.** 202 → job `publish` (ключ дедупа = listing_id, только последняя версия) → маппинг и валидация → картинки: скачиваем по URL (защита от SSRF, см. ниже), проверяем MIME/размер, через sharp делаем jpg с длинной стороной ≤1600, режем до 16 → `pics` по одной с ретраями, кэш `sha256 → pin_pic_id` → `validate_ad` → `POST /items/` с `external_id` = `<agencyPrefix>-<external_id>` → сохраняем `pin_item_id` → webhook `listing.synced` → планируем status-sync.
3. **Обновление.** Если `payload_hash` не изменился, ничего не делаем. Иначе считаем diff полей и вызываем `PATCH partial_update`. Если поменялись картинки, догружаем только новые (по sha256). Если поменялась рубрика, делаем полный `POST /items/<id>/`.
4. **Снять / вернуть / удалить**: `toggle_active` и `to_remove`, идемпотентно по `desired_state` (повторный вызов не дёргает Pin).
5. **Модерация и оплата.** Воркер `status-sync` раз в 5–10 мин опрашивает `front_my` по каждому connection, у которого есть объявления в нефинальных состояниях. Свежесозданные объявления опрашиваются чаще: 1, 5, 15 мин. Смену `status`/`not_paid` записываем и шлём webhook. `not_paid=true` → `awaiting_payment` (оплата с баланса клиента на стороне Pin, мы её не проводим).
6. **Таймаут на POST /items** (не знаем, создалось ли): перед ретраем ищем `external_id` в `front_my`. Если нашли, привязываем, а не создаём дубль.
7. **Токен недействителен** (401/403 с токеном, не Cloudflare): connection → `reauth_required`, его jobs ставятся на паузу, webhook. После повторного confirm jobs продолжаются.
8. **Cloudflare 403 / 429 / 5xx / сетевые ошибки**: ретрай с экспоненциальной задержкой и jitter (5 попыток, до ~30 мин), circuit breaker на весь Pin (открывается при ≥50% ошибок за 1 мин, на это алерт). 4xx валидации не ретраим: `failed` + webhook с ошибкой Pin.
9. **Справочники**: `dict-sync` раз в сутки и при старте. Если `rubric_form` изменился, логируем diff и шлём алерт (маппинг мог сломаться).
10. **Пачка от агентства** (сотни объявлений сразу): очередь со справедливой раздачей по агентствам (BullMQ groups / rate limit на агентство), чтобы одно агентство не забило Pin для остальных.

## Безопасность

- **Вход**: TLS 1.2+ (Caddy с авто-сертификатом), только 443 наружу, SSH по ключу с ограничением IP, ufw/fail2ban. Админ-эндпоинты отдельно и не публично.
- **Аутентификация агентств**: API-ключ (храним только хэш, префикс для поиска) + HMAC-подпись, окно timestamp ±5 мин, nonce в Redis (защита от replay), опциональный IP allowlist на агентство, ротация ключей (2 активных одновременно). Опционально позже mTLS.
- **Изоляция тенантов**: каждый запрос в БД фильтруется по `agency_id` из ключа (guard + repository-слой). Для чужих id отдаём 404, а не 403.
- **Секреты**: токены Pin, device keys, HMAC-секреты шифруются AES-256-GCM (envelope, мастер-ключ в env / secret manager, ротация через key_id). Токен Pin **никогда** не покидает сервер.
- **SSRF при загрузке картинок**: только https, резолвим DNS и запрещаем приватные, loopback и link-local диапазоны (и после редиректов), максимум 3 редиректа, таймаут 15с, лимит 15 МБ потоком, проверка magic bytes, sharp запускается с `limitInputPixels`.
- **Валидация** всех входных данных через zod, лимит тела 1 МБ, санитизация title/description.
- **Rate limit**: на ключ агентства (Redis token bucket), отдельно жёсткий лимит на SMS-эндпоинты.
- **Логи**: pino redaction (token, Device-Api-Key, Authorization, code, телефон маскируется), audit_log для действий с подключениями.
- **Исходящие webhooks**: HMAC-подпись, только https, такая же SSRF-проверка.

## Стабильность и время отклика

- SLO: API агентствам p95 < 150 мс (только БД + enqueue). Публикация без картинок < 10 с, с 16 картинками < 60 с при живом Pin.
- **Защита Pin от нас**: глобальный rate limiter исходящих запросов (Redis, стартуем с ~5 rps, настраивается), конкурентность на connection = 1 (порядок операций по объявлению), undici pool с keep-alive и таймаутами (connect 5с, request 30с, upload 60с).
- Transactional outbox для webhook-событий (событие пишется в той же транзакции, что и смена статуса). Доставка с ретраями до 24ч, потом DLQ.
- Идемпотентность везде: `Idempotency-Key` на входе, дедуп jobs по listing_id, проверка `front_my` перед повторным созданием.
- Graceful shutdown воркеров (дожидаемся текущих jobs), BullMQ stalled-job recovery, Redis AOF, бэкапы Postgres (pg_dump ежедневно + WAL, если managed).
- Health: `/health/live`, `/health/ready` (БД, Redis, состояние circuit breaker'а Pin). Синтетическая проверка Pin раз в 5 мин (`GET all_cities`).
- Метрики: латентность и коды ответов Pin по эндпоинтам, глубина очередей, возраст старейшего job, доля failed, доставка webhook'ов. Алерты в Telegram/Slack.

## Этапы разработки

1. **Фундамент (2–3 дня)**: скелет NestJS (api+worker), env-конфиг, Prisma-схема и миграции, Docker Compose (api, worker, postgres, redis, caddy), pino, health, CI (lint, typecheck, test).
2. **PinClient (2–3 дня)**: типизированный клиент на все ручки из таски, маппинг ошибок, ретраи, circuit breaker, rate limiter, **fake-pin сервер** для тестов (поведение по описанию из комментариев, включая лимит SMS и молчаливое обрезание до 16 картинок). Smoke-проверка с реального сервера: `device_api_key` проходит Cloudflare.
3. **Агентства и auth (2 дня)**: CLI/админ-ручка для создания агентства и ключей, HMAC guard, nonce, rate limit, audit.
4. **Connections / SMS-flow (2 дня)**: шифрование, кулдауны, статусы, reauth.
5. **Справочники и маппер (2–3 дня)**: dict-sync, каноническая схема для рубрик 20/21 (потом остальные недвижимые subtypes по разметке клиента), `/validate`.
6. **Листинги и публикация (4–5 дней)**: upsert, idempotency, pipeline картинок, publish/update/toggle/remove jobs, защита от дублей.
7. **Status-sync и webhooks (2–3 дня)**: поллинг `front_my`, outbox, подписанная доставка, DLQ.
8. **Наблюдаемость и hardening (2 дня)**: метрики, алерты, нагрузочный тест k6, security review, бэкапы.
9. **Документация и пилот (2 дня)**: OpenAPI + пример клиента (Node/PHP) для агентств, онбординг первого агентства, прогон на проде тестовым номером.

## Что запросить у Pin / Руслана (блокеры)

- Подтвердить, что в allowlist Cloudflare добавлен **статический IP нашего сервера** (и какой именно; при переезде нужно согласование).
- Тестовый номер TT с фиксированным кодом (обещали).
- Есть ли rate limit на `items` / `pics` у прода, какой rps безопасен.
- Можно ли переиспользовать `pin_pic_id` между объявлениями и правках, есть ли у них TTL.
- Есть ли вебхуки модерации у Pin (тогда можно отказаться от поллинга).
- Поведение `front_my`: пагинация и фильтр по `external_id`.
- Разметка property types/subtypes клиента (вложение в таске) для маппинга.

## Verification

- `npm run lint && npm run typecheck && npm test`: unit (маппер, HMAC, crypto, state machine) и contract-тесты против fake-pin (все сценарии 1–10, включая таймаут POST /items, 401, 403 Cloudflare, лимит SMS, >16 картинок, not_paid).
- `docker compose up` локально, e2e: тестовое агентство → connect с fake-pin → PUT listing → webhook `listing.synced` → смена статуса в fake-pin → webhook `status_changed`.
- SSRF-тесты (`http://169.254.169.254`, `localhost`, редирект на приватный IP) должны быть отклонены.
- k6: 50 rps на `PUT listings`, p95 < 150 мс, исходящий поток к Pin не выше лимитера.
- Прод-smoke с разрешённого сервера: `device_api_key` → `phone_verify` тестовым номером → публикация в рубрике 21 с ценой < 4000 (бесплатно) → проверка `status==0 && not_paid==false` → `to_remove`.
