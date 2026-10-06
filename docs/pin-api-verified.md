# Pin API: что проверено на проде

Реальные запросы к `https://pin.tt/api/v1.6` с сервера Pin Bridge и ответы на них. Здесь только
то, что видели своими глазами. Описание от разработчика Pin (ClickUp, таска 869eyj21n) местами
расходится с продом, расхождения отмечены.

| Шаг                                 | Статус                      | Дата  |
| ----------------------------------- | --------------------------- | ----- |
| Allowlist сервера                   | ✅ пускает                  | 06.10 |
| `POST /items/device_api_key/`       | ✅ 201                      | 06.10 |
| `GET /users/phone_verify/`          | ✅ 200, SMS ушла            | 06.10 |
| `POST /users/phone_verify/?token=1` | ⏳ не проверено (нужен код) |       |
| Справочники без токена              | ⏳ не проверено             |       |
| Публикация                          | ⏳ не проверено             |       |

## 1. Ключ устройства

```bash
curl -4 -sS -i -X POST https://pin.tt/api/v1.6/items/device_api_key/ \
  -H 'Content-Type: application/json' -H 'Accept: application/json'
```

```
HTTP/2 201
server: cloudflare

{"id":"3e123cc1-…","user":1120272,"push_token":null,"created":"2026-10-06T12:46:07.341696+00:00",
 "last_modified":"…","maestro_uuid":null,"ip":"","platform":"","manufacturer":"","model":"",
 "os":"","app":"","phone":""}
```

- **Ключ в поле `id`**, а не `uuid`, как в описании. `maestro_uuid` к ключу отношения не имеет.
- **Каждый вызов создаёт на Pin нового пользователя** (`"user":1120268`, затем `1120272`). Поэтому
  Pin Bridge создаёт ключ только на новое подключение номера, а справочники и `pin-smoke` берут
  один сохранённый служебный ключ.

## 2. Отправка SMS

```bash
DK=<id из шага 1>
curl -4 -sS -i -G https://pin.tt/api/v1.6/users/phone_verify/ \
  -H "Device-Api-Key: $DK" -H 'Accept: application/json' \
  --data-urlencode 'phone=+1 868 681 3498' --data-urlencode 'check_type=sms'
```

```
HTTP/2 200

{"status":0,"errors":null,"end_date":60}
```

- `status: 0` значит, что SMS отправлена. `errors: null` при успехе.
- `end_date` приходит **числом** (секунды до следующей SMS), а не строкой.
- Номер в формате `+1 868 XXX XXXX` (с пробелами) принят. Pin Bridge отправляет номера именно в
  нём, хотя хранит без пробелов.
- Номер не из Тринидада и Тобаго: `{"status":1,"errors":["Could not determine the country by number"],"end_date":""}`.

## 3. Код из SMS → токен (ещё не проверено)

```bash
CODE=<код из SMS>
curl -4 -sS -X POST "https://pin.tt/api/v1.6/users/phone_verify/?token=1" \
  -H 'Content-Type: application/json' -H 'Accept: application/json' -H "Device-Api-Key: $DK" \
  -d "{\"phone\": \"+1 868 681 3498\", \"code\": \"$CODE\", \"check_type\": \"sms\"}"
```

Ожидаем `{"status": 0, "token": "…"}`. `Device-Api-Key` нужен тот же, что в шаге 2. Токен бессрочный
и даёт полный доступ к аккаунту на Pin: не публикуйте его.

## 4. Запросы от имени пользователя

Дальше в каждом запросе оба заголовка (обратите внимание на закрывающую кавычку):

```bash
TOKEN=<token из шага 3>
curl -4 -sS https://pin.tt/api/v1.6/items/front_my/ \
  -H 'Accept: application/json' -H "Device-Api-Key: $DK" -H "Authorization: Token $TOKEN"
```

## 5. Справочники (ещё не проверено)

Pin Bridge запрашивает их только со служебным `Device-Api-Key`, без токена:

```bash
curl -4 -sS -o /dev/null -w '%{http_code}\n' https://pin.tt/api/v1.6/items/tree_v2/ -H "Device-Api-Key: $DK"
curl -4 -sS https://pin.tt/api/v1.6/items/rubric_form/21/ -H "Device-Api-Key: $DK" | head -c 3000
```

Если Pin откажет без токена (401 или 403), worker один раз создаст новый служебный ключ, а если
откажут и ему, загрузит справочники с токеном любого активного подключения. В логе worker будет
`using a connection token`. Пока ни одного номера не подключено, справочники в этом случае не
загрузятся.
