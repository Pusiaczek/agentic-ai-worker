# Infrastruktura testów aw — kontrakt i plan

Status: projekt, ustalenia z 2026-09-29 (kontekst i decyzje: punkt 12 w [TODO.md](../TODO.md)). M0 zrobiony 2026-09-29, wyniki w sekcji [Wyniki M0](#wyniki-m0). Dalsze etapy wstrzymane do czasu apki z co najmniej 5000 testów (decyzja z 2026-09-30, punkt 12 w TODO).

## Cel

Agenci aw mają dostawać wyniki testów szybko i pewnie:

- mniej czasu na wielokrotne uruchamianie testów,
- równoległe przebiegi nie wpływają na siebie przez dane w bazie,
- zawsze wiadomo, dla jakiego stanu kodu jest dany wynik.

## Zasady

1. **Deterministycznie.** Kod decyduje, kiedy i jak lecą testy. Model woła `aw test` i co najwyżej uzupełnia konfigurację; o tym, czy konfiguracja działa, rozstrzyga weryfikacja (kod), a nie model.
2. **Zero zmian w projekcie.** W repo nie ma nic specyficznego dla aw: setup potrzebny aw jest wstrzykiwany w locie. `npm test` uruchamiany ręcznie działa jak dotąd.
3. **Bramka przy submicie jest wiążąca.** Świeży proces, pełny zestaw testów.
4. **Wynik bez potwierdzonej świeżości nie trafia do agenta jako aktualny.**
5. **Zakres: vitest + Postgres.** Dla innych runnerów i baz zostaje zwykłe `aw test` (jak dziś), bez serwera i torów baz.

## Składniki

### Serwer testów

- Proces Node używający vitesta **jako biblioteki** (`vitest/node`), załadowanego z `node_modules` projektu (jego wersja). Ta sama konfiguracja co komenda testów projektu: `vitest.config.*`, `setupFiles`, `globalSetup`, env ładowany przez config. Argumenty i zmienne ze skryptu npm (np. `cross-env TZ=UTC vitest --config …`) są jawnie w configu aw.
- **Środowisko:** aw dodaje tylko zmienne `AW_*` oraz `CI=1` i `NO_COLOR=1` (jak dziś `aw test` i bramki). Zmiennych projektu nie nadpisuje. Jedyny wyjątek to zmienna z adresem bazy w workerze (M2).
- Komunikacja przez lokalne HTTP (`127.0.0.1`). Port, pid i token w `.tasks/test-server/server.json`. Endpointy: `/run` (pliki + filtr → zwięzły wynik), `/status`, `/stop`. Agent nie rozmawia z HTTP — tylko przez `aw test`.
- Wyniki pochodzą z API vitesta (moduły i testy ze stanem, czasem i błędami), a nie z parsowania tekstu.
- `globalSetup` projektu wykonuje się raz na życie serwera, a teardown przy zamknięciu (potwierdzone w M0).
- Start: automatycznie przez `aw test` albo ręcznie w terminalu użytkownika (wtedy `aw test` używa tego serwera). Stop: przy archiwizacji taska, na żądanie albo sam po czasie bezczynności.
- Restart = nowy proces (czyste `process.env`). Następuje, gdy zmieni się odcisk plików konfiguracyjnych (`vitest.config.*`, `.env*`, `package.json`, lockfile), i profilaktycznie po N przebiegach.
- Jeden przebieg naraz na tor, anulowanie po przekroczeniu czasu.

### Tory

Każdy tor ma własne bazy danych.

| Tor | Co uruchamia | Kiedy | Kto korzysta z wyniku |
|---|---|---|---|
| żądań | pliki i filtr z `aw test` | na żądanie | agent (odpowiedź na `aw test`) |
| taska | wszystkie testy taska (chronione i zadeklarowane) | automatycznie po zmianach | `aw test` dołącza ostatni **świeży** wynik |
| bramki | pełny zestaw | przy submicie, świeży proces | CLI (wynik wiążący) |

### Postgres

- **Jeden serwer, wiele baz.** `aw db up` stawia kontener z danymi w `tmpfs` (RAM), z wyłączoną trwałością (`fsync=off`, `synchronous_commit=off`, `full_page_writes=off`) i podniesionym `max_connections` (tory × workery × pula połączeń projektu). Liczbę workerów na tor ogranicza config aw: domyślnie vitest bierze liczbę wątków CPU − 1 (na i9 z pilota to 31).
- **Szablon** `aw_tpl_<hash migracji>`: pusta baza → komenda migracji z adresem tej bazy (opcjonalnie komenda seedu) → oznaczenie jako szablon. Przy zmianie migracji powstaje nowy, a stare są sprzątane.
- **Baza workera** `aw_<tor>_w<VITEST_POOL_ID>` (vitest numeruje workery od 1 do `maxWorkers`): klon szablonu na starcie przebiegu.
- **Czyszczenie:** jedno `TRUNCATE` na wszystkie tabele naraz (lista z katalogu bazy, bez tabeli migracji i tabel do zachowania), **bez** `CASCADE`. Domyślnie na początku każdego pliku testów, opcjonalnie przed każdym testem.

### Setup wstrzykiwany w locie

Plik z pluginu dokładany przez API vitesta **przed** setupem projektu. Wybiera bazę workera, ustawia zmienną z adresem bazy (nazwa w configu, np. `DATABASE_URL`) i czyści tabele.

Vitest przy opcjach podanych przez API **zastępuje** listy z configu projektu (nie dokleja). Dlatego aw najpierw odczytuje `setupFiles` i `globalSetup` projektu (`resolveConfig`) i podaje `[plik aw, ...pliki projektu]`.

Warunki po stronie projektu:

- adres bazy pochodzi ze zmiennej środowiskowej w chwili łączenia,
- testy nie zależą od danych z innych plików testów,
- jeśli projekt sam zarządza bazą w `globalSetup` (np. testcontainers), funkcja jest wyłączona.

## Reguła świeżości

Wynik przebiegu jest **świeży**, gdy:

1. przebieg wystartował **po** ostatniej modyfikacji istotnych plików (śledzone przez git i nowe nieignorowane, bez `.tasks/`), **oraz**
2. żaden z tych plików nie zmienił się **w trakcie** przebiegu (sprawdzenie na końcu).

Nieświeży wynik jest oznaczany, a nie ukrywany.

Serwer nie polega na watcherze plików. Przy `watch: false` vitest w ogóle go nie uruchamia, a przy włączonym zdarzenia przychodzą z opóźnieniem. Przed każdym przebiegiem serwer sam porównuje istotne pliki (czas modyfikacji i rozmiar) ze stanem z poprzedniego przebiegu i jawnie unieważnia zmienione. Robi dokładnie to, co watcher vitesta, ale bez automatycznego przebiegu: `invalidateFile` dla cache transformacji i lista unieważnień przekazywana workerom. M0 potwierdził, że bez tego serwer zwraca nieaktualny wynik.

## Wykrywanie (kod, deterministycznie)

| Co | Reguła |
|---|---|
| komenda migracji | skrypt projektu o znanej nazwie (`db:migrate`, `migrate`, `migration:run`…), potem tabela ORM-ów niżej, a gdy brak — pytanie w `/aw:init-tests` |
| zmienna z adresem bazy | `DATABASE_URL`, `DB_URL`, `POSTGRES_URL`, `PG_URL` w `.env.test` / `.env`, a gdy brak — pytanie |
| runner | `vitest` w zależnościach |
| tabele do zachowania | tabela migracji wykrytego narzędzia + lista z configu |

| Zależność | Komenda migracji | Tabela migracji |
|---|---|---|
| `drizzle-kit` | `npx drizzle-kit migrate` | `__drizzle_migrations` |
| `prisma` | `npx prisma migrate deploy` | `_prisma_migrations` |
| `knex` | `npx knex migrate:latest` | `knex_migrations` |
| `node-pg-migrate` | `npx node-pg-migrate up` | `pgmigrations` |
| `sequelize-cli` | `npx sequelize-cli db:migrate` | `SequelizeMeta` |
| `typeorm` | `npx typeorm migration:run -d <plik>` | `migrations` |

## Kontrakt

Każdy punkt ma automatyczne sprawdzenie (`aw test-infra verify`) i warunek zaliczenia liczony przez kod. Konfiguracja jest gotowa, gdy wszystkie mające zastosowanie punkty poza K8 mają ✓. Punkty bazodanowe (K4, K5) obowiązują tylko przy włączonym Postgresie.

| # | Wymaganie | Sprawdzenie | Warunek zaliczenia |
|---|---|---|---|
| K1 | serwer daje te same wyniki co zwykłe uruchomienie | te same pliki raz przez serwer, raz zwykłą komendą | równe liczby zaliczonych, oblanych i pominiętych; identyczna lista oblanych |
| K2 | serwer widzi zmiany w kodzie | sonda: moduł `value = 1` + test sprawdzający `value`; przebieg; zmiana modułu na `2`; przebieg | przebieg 1: dokładnie 1 zaliczony; przebieg 2: dokładnie 1 oblany |
| K3 | tory nie wpływają na siebie | pełny zestaw w dwóch torach jednocześnie | oba wyniki równe przebiegowi pojedynczemu |
| K4 | szablon odpowiada migracjom | hash migracji vs nazwa szablonu; tabele w szablonie | szablon o aktualnym hashu istnieje i ma tabele projektu |
| K5 | zwykła baza testowa nietknięta | liczniki zapisów w `pg_stat_database` dla bazy z `.env.test`, przed i po (jeśli osiągalna) | brak nowych zapisów |
| K6 | repo nietknięte | `git status --porcelain` przed i po | identyczne |
| K7 | po wszystkim nie zostają śmieci | po zakończeniu / `aw db gc` | brak baz `aw_*` poza aktualnym szablonem i aktywnymi torami; brak plików sondy |
| K8 | jest szybciej (informacyjnie) | zimny start vs serwer, ten sam zestaw | raport liczb, bez progu |
| K9 | restart przy zmianie konfiguracji | zmiana odcisku (np. `.env.test`) | kolejne żądanie obsługuje nowy proces serwera (inny pid) |

Sonda (K2) tworzy pliki o nazwie `__aw_probe__` obok istniejącego pliku testów, z tym samym sufiksem, i sprawdza przez API vitesta, że pasują do `include`. Sprząta je w `finally`, a pozostałości po awarii usuwa kolejne uruchomienie po wzorcu nazwy.

## `/aw:init-tests`

Osobny skill do konfiguracji infrastruktury testów. Pętla:

1. wykryj (kod),
2. uzupełnij config — tylko to, czego kod nie rozstrzygnął,
3. `aw test-infra verify`,
4. przy ✗ popraw config i wróć do 3, albo zgłoś blokadę użytkownikowi.

Model nie ogłasza sukcesu — robi to weryfikacja.

## Etapy

| Etap | Zakres | Kontrakt |
|---|---|---|
| **M0** (prototyp) ✓ | osobny skrypt [`proto/m0-vitest`](../proto/m0-vitest/), bez zmian w `test-aw`: vitest przez API w wersji z projektu, wybrane pliki z filtrem, jawne unieważnianie zmian, wstrzyknięcie setupFile i globalSetup; pomiary: narzut zimnego startu, przebieg na serwerze, koszt setupu na test | K1, K2, K6, K8 ✓ |
| **M1** | serwer testów, tor żądań, `aw test` przez serwer (z trybem awaryjnym), restart, reguła świeżości | + K9 |
| **M2** | Postgres: `aw db up/template/gc`, tory baz, setup wstrzykiwany, tor taska | + K3, K4, K5, K7 |
| **M3** | bramka przez runner aw na własnym torze, `aw test-infra verify`, `/aw:init-tests`, `aw doctor` | całość |
| później | tor regresji (wszystkie testy w tle), adapter dla jest, `--related` | — |

## Wyniki M0

Pomiar 2026-09-29. Środowisko: vitest 5.0.2, Node 22.14, Windows 11, i9-13900HX (32 wątki). Dwa projekty:

- **test-aw**: pilot (Fastify + drizzle + PGlite), 5 plików, 246 testów, z czego 207 w jednym pliku;
- **kopia** w [`fixtures/test-aw`](../fixtures/README.md): te same testy, ale `users.test.ts` jest rozbity na 5 plików (razem 9).

Skrypty:

- [`m0.mjs`](../proto/m0-vitest/m0.mjs) sprawdza kontrakt i mierzy czasy;
- [`db-reset-cost.mjs`](../proto/m0-vitest/db-reset-cost.mjs) mierzy koszt czystej bazy na test.

### Punkty kontraktu

Wszystkie ✓ na obu projektach.

| Punkt | Wynik |
|---|---|
| K1 | ✓ Pełny zestaw, pojedyncze pliki i filtr `-t PATCH` (82 zaliczone, 164 pominięte) dają te same liczby i tę samą listę oblanych co zwykłe `vitest run`. |
| K2 | ✓ Wartość 1 daje zaliczony, 2 oblany, powrót do 1 znowu zaliczony. **Bez unieważnienia serwer zwrócił nieaktualny wynik:** dla wartości 2 test nadal był zaliczony. |
| K6 | ✓ `git status` przed i po jest identyczny. Status listuje każdy nieśledzony plik osobno, więc zostawiona sonda byłaby widoczna. |
| wstrzyknięcie | ✓ `setupFiles` i `globalSetup` z katalogu spoza projektu działają: worker widzi zmienną ustawioną przez plik aw. Na kopii, która ma własne pliki setupu, kolejność to plik aw, potem plik projektu; plików projektu nic nie wypiera. |
| globalSetup | ✓ Setup i teardown wykonały się dokładnie raz na instancję (przy 11 i 17 przebiegach). |

### Czasy (K8)

Serwer oszczędza stały koszt **każdego wywołania**, niezależnie od liczby testów. Pomiar na kopii, mediana z 3 uruchomień:

| Plik | Testy | `npx vitest run` | `node …/vitest.mjs run` | serwer | oszczędność |
|---|---|---|---|---|---|
| `config.test.ts` (bez bazy) | 6 | 1,03 s | 0,52 s | 0,13 s | 0,90 s |
| `users-db-errors.test.ts` | 6 | 4,34 s | 3,86 s | 3,52 s | 0,82 s |
| `users-list.test.ts` | 24 | 8,74 s | 8,31 s | 7,72 s | 1,02 s |

- Z tej oszczędności ok. 0,5 s to samo `npx`, a ok. 0,4 s to start vitesta: Node, config i pula workerów.
- Pełny zestaw kopii: zwykły przebieg 30,3 s (1,0 s startu, 29,2 s testów, 0,1 s wyjścia), serwer 29,2–29,4 s. Czyli ta sama sekunda. Jeden zwykły przebieg w M0 trwał 64 s, bo proces kończył się 31 s po ostatnim teście; kontrolny przebieg tego nie powtórzył.
- Na test-aw wzorzec był ten sam, a liczby trochę wyższe (plik bez bazy: 1,4 / 0,7 / 0,2 s). Różnice między seriami to stan maszyny.
- Najkrótszy przebieg na serwerze trwa 0,13–0,2 s, start instancji przez API ok. 0,15 s, a skan zmian przed przebiegiem (`git ls-files` + `stat`, 30–35 plików) 19–33 ms.

### Tło: czas jednego przebiegu

Celem etapu 2 jest czas tracony na wielokrotnym uruchamianiu testów, a nie długość jednego przebiegu (decyzja użytkownika). Te liczby są tylko tłem:

- W test-aw `users.test.ts` (207 z 246 testów) leci 87–94 s na jednym workerze, bo vitest rozkłada na workery całe pliki. Kopia z tymi testami w 5 plikach robi pełny zestaw w ok. 30 s.
- Nowa PGlite z kopii szablonu na każdy test: mediana 350 ms. `TRUNCATE` wszystkich tabel na jednej instancji: mediana 2,1 ms. To potwierdza wybór z M2: czyszczenie przez `TRUNCATE`, a nie świeża kopia bazy na test.
- test-aw trzyma dziś PGlite w procesie testów. Tory baz z M2 obejmą go, gdy helper testów przejdzie na testowy Postgres przez zmienną z adresem (plan: Postgres w Dockerze, najpierw na kopii).

### Baza w testach: silnik i metoda czyszczenia

W kopii bazę testów wybiera komenda, która je uruchamia (`npm run test:pg` itd., zob. [fixtures/README.md](../fixtures/README.md)); `.env.test` trzyma tylko adres Postgresa. Są dwa przełączniki, żeby oddzielić dwa pytania: czy pomaga osobny serwer i czy pomaga czyszczenie zamiast nowej bazy. [`db-matrix.mjs`](../proto/m0-vitest/db-matrix.mjs) puszcza pełny zestaw w każdym wariancie, na przemian (każdy wariant raz, potem znowu), mediana z 3 przebiegów (2026-09-30):

| Serwer | Czyszczenie | Pełny zestaw | Mediana testu | p90 testu |
|---|---|---|---|---|
| PGlite w procesie | nowa baza na test | 30,0 s | 420 ms | 533 ms |
| PGlite w procesie | `TRUNCATE` przed testem | 8,4 s | 40 ms | 67 ms |
| Postgres 18 natywnie na Windowsie | nowa baza na test | 62,3 s | 881 ms | 1103 ms |
| Postgres 18 natywnie na Windowsie | `TRUNCATE` przed testem | 12,6 s | 43 ms | 71 ms |
| Postgres 18 w Dockerze (WSL2, dane w RAM) | nowa baza na test | 6,7 s | 63 ms | 100 ms |
| Postgres 18 w Dockerze (WSL2, dane w RAM) | `TRUNCATE` przed testem | 4,7 s | 30 ms | 57 ms |

- Wszystkie warianty dają te same wyniki: 246 zaliczonych w każdym przebiegu. Rozrzut przebiegów w obrębie wariantu: do ok. 10%.
- **Najszybszy jest linuksowy Postgres z danymi w RAM:** 4,7 s. To ok. 6× szybciej niż dzisiejsze podejście pilota (PGlite z nową bazą na test) i ok. 1,8× szybciej niż PGlite z `TRUNCATE`. Nawet nowa baza na każdy test (klon szablonu, mediana 63 ms) jest tam szybsza niż PGlite z `TRUNCATE`.
- **Postgres natywnie na Windowsie jest najwolniejszy:** każde połączenie to nowy proces, a pliki bazy leżą na NTFS. Przy domyślnych ustawieniach (`fsync=on`) `DROP DATABASE` czekał na wymuszony checkpoint do 11 s (w `pg_stat_activity`: `IPC: CheckpointDone`) i przekraczał 10-sekundowy limit hooka. Tabela jest dla `fsync`, `synchronous_commit` i `full_page_writes` wyłączonych.
- `TRUNCATE` zamiast nowej bazy na test daje od 1,4× (Docker) do ok. 5× (Windows), zależnie od serwera.
- Dla M2: `DROP DATABASE` zawsze wymusza checkpoint, więc bazy workerów tworzyć raz na przebieg i czyścić `TRUNCATE`, a nie tworzyć i usuwać na każdy test.
- Liczby bezwzględne zależą od sesji. Ten sam wariant PGlite w innej sesji dał 25,8–38,8 s, więc porównywać proporcje w obrębie jednego pomiaru.

### Fakty o API vitesta 5.0.2 (dla M1)

- `runTestSpecifications` zwraca w `testModules` **wszystkie** moduły znane instancji, także z wcześniejszych przebiegów. Wynik trzeba zawęzić do modułów z żądania.
- Filtr nazw ustawia się osobno dla każdego pliku: `project.createSpecification(plik, { testNamePattern })`.
- `resolveConfig().test` daje bezwzględne ścieżki `setupFiles` i `globalSetup` projektu.
- `reporters: [{}]` wycisza wyjście, a wyniki idą z API.
- Przy `watch: false` domyślne `maxWorkers` to liczba wątków CPU − 1 (tu 31).

### Co to zmienia

- **Wielokrotne `aw test` przez serwer (M1):** każde wywołanie jest krótsze o ok. 0,8–1 s względem `npx vitest run`, niezależnie od liczby testów. Przy 30 wywołaniach w tasku to ok. pół minuty. Świeżość zapewnia jawne unieważnianie; bez niego wynik jest nieaktualny (K2). Dalszy zysk na powtórkach dadzą tory: wynik toru taska czeka gotowy, zanim agent o niego zapyta.
- **Niezależnie od serwera:** `aw test` przez lokalną binarkę vitesta zamiast `npx` to ok. 0,5–0,7 s mniej na każde wywołanie. To zmiana w wykrywaniu komend w `/aw:init`.
- **Baza:** linuksowy Postgres z danymi w RAM (Docker w WSL2) jest najszybszy: pełny zestaw 4,7 s wobec 30 s dziś (PGlite, nowa baza na test). To potwierdza kierunek M2: Postgres w Dockerze z danymi w RAM, szablon i `TRUNCATE`. Postgres natywnie na Windowsie odpada jako najwolniejszy wariant.
- **Kolejność:** etapy wstrzymane do czasu apki z co najmniej 5000 testów; wtedy powtórzyć pomiary tymi samymi skryptami. Baza testowa: Postgres w Dockerze na Linuksie z danymi w RAM (Postgres natywnie na Windowsie odpada).

## Otwarte kwestie

- Tor taska: przy każdej zmianie pliku czy w „spójnych momentach” (np. po `aw test`)? Decyzja po M1.
- Tor żądań i tor taska: dwie instancje vitesta czy jedna z kolejką? M1.
- Czy bramka może korzystać z rozgrzanego serwera? Domyślnie nie (wiarygodność).
