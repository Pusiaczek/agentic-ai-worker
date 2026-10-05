# fixtures

Przykładowe projekty do sprawdzania infrastruktury testów aw: serwera testów, torów i Postgresa (zob. [docs/test-infra.md](../docs/test-infra.md)). Nie są częścią pluginu. Testy aw ich nie uruchamiają, bo `vitest.config.ts` w repo aw obejmuje tylko `test/**`.

## test-aw

Kopia pilota `test-aw` (Fastify + drizzle + PGlite) z 2026-09-29. Bez `.git`, `node_modules`, `dist` i plików aw (`.claude`, `.tasks`, `CLAUDE.local.md`).

Oryginał zostaje w `D:/FB/Projects/test-aw` jako pilot workflow aw i dalej się zmienia. Kopia jest zamrożona, żeby pomiary dało się powtarzać.

Różnica względem oryginału: `test/routes/users.test.ts` (207 testów) jest rozbity na 5 plików według endpointów:

| Plik | Bloki z oryginału | Testy |
|---|---|---|
| `users-create.test.ts` | POST /users | 71 |
| `users-update.test.ts` | PATCH /users/:id | 64 |
| `users-get-delete.test.ts` | GET /users/:id, złe id, DELETE /users/:id | 42 |
| `users-list.test.ts` | GET /users | 24 |
| `users-db-errors.test.ts` | błędy bazy inne niż unikalność e-maila | 6 |

Bloki `describe` są przeniesione bez zmian. Wspólny początek pliku jest w `test/helpers/users-routes.ts`: każdy plik woła `useFreshApp()`, które rejestruje te same hooki co wcześniej (osobna aplikacja i baza na test). Vitest rozkłada teraz testy na workery, więc pełny zestaw trwa ok. 34 s zamiast ok. 90 s.

Użycie (z katalogu głównego repo aw):

```sh
cd fixtures/test-aw && npm ci && npm test && cd ../..
node proto/m0-vitest/m0.mjs fixtures/test-aw --small test/config.test.ts --small test/routes/users-list.test.ts
node proto/m0-vitest/db-matrix.mjs fixtures/test-aw
```

### Baza w testach

W oryginale testy mają tylko PGlite z nową bazą na każdy test. W kopii bazę wybiera komenda, która uruchamia testy, a nie plik do ręcznej edycji:

| Komenda | Baza | Czyszczenie |
|---|---|---|
| `npm test` | PGlite w procesie testów | nowa baza na każdy test (`fresh`) |
| `npm run test:truncate` | PGlite w procesie testów | jedna baza na plik, `TRUNCATE` przed każdym testem |
| `npm run test:pg` | serwer Postgres | nowa baza na każdy test (klon szablonu) |
| `npm run test:pg:truncate` | serwer Postgres | jedna baza na worker, `TRUNCATE` przed każdym testem |

Pod spodem komendy podają vitestowi tryb (`--mode pglite-truncate`, `postgres`, `postgres-truncate`), a `vitest.config.ts` zamienia go na bazę. Tak samo robi [`db-matrix.mjs`](../proto/m0-vitest/db-matrix.mjs): puszcza pełny zestaw w każdym trybie i sprawdza, że wyniki testów są wszędzie takie same. Przełączniki są dwa, bo pytania są dwa: czy pomaga osobny serwer (silnik) i czy pomaga czyszczenie zamiast nowej bazy (metoda).

`.env.test` (wzór: `.env.test.example`) trzyma tylko połączenie z Postgresem: `TEST_DATABASE_URL`, z użytkownikiem z prawem `CREATEDB`. Inne zmienne z tego pliku są ignorowane, więc zapomniany wpis nie przełączy bazy po cichu.

Testy, które zamykają połączenie albo zmieniają schemat (`health`, `users-db-errors`), zawsze dostają własną bazę (`ownDatabase`).

Przy Postgresie `test/global-setup.ts` raz na przebieg tworzy zmigrowany szablon `test_aw_template`. Bazy testów to jego klony (`CREATE DATABASE … TEMPLATE`): `test_aw_w<worker>` przy `truncate` i `test_aw_w<worker>_t<n>` przy `fresh`. Po przebiegu wszystkie bazy `test_aw_*` są usuwane.

### Skąd wziąć Postgresa

Z Dockera na Linuksie, także z Dockera w WSL2 bez Docker Desktop: `docker compose up --wait` w `fixtures/test-aw` (z WSL: `/mnt/d/FB/Projects/agentic-ai-worker/fixtures/test-aw`). Dane są w RAM, trwałość wyłączona, port 5433, adres `postgres://postgres:postgres@localhost:5433/postgres`.

Postgres zainstalowany natywnie na Windowsie odpada: w pomiarach był najwolniejszy, 2–10× wolniejszy od Dockera (zob. docs/test-infra.md, „Baza w testach”).
