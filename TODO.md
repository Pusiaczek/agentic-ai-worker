# TODO — pomysły i poprawki do pluginu aw

Każdy punkt: co zrobić, skąd się wziął i których plików dotyczy. Przy wdrożeniu przenieś do sekcji „Zrobione” albo usuń.

## Do zrobienia

### 1. Scrum-master zatrzymuje się przy brudnym drzewie gita
- **Co:** gdy `aw sm new` ostrzega o niezacommitowanych zmianach, skill ma się zatrzymać, pokazać listę plików i zapytać: zacommitować / schować (stash) / kontynuować mimo to.
- **Opcjonalnie:** komenda typu `aw sm rebase`, która pozwala ponownie zapisać `git.baseRef`, dopóki żaden agent nie wystartował (brak `runs`).
- **Skąd:** pilot `2026-09-28-users-crud` wystartował z niezacommitowanymi zmianami (README.md, package.json, usunięty docker-compose.yml, katalog `fifi/`). CLI ostrzegło, ale scrum-master poszedł dalej. `baseRef` zapisuje się przy starcie, więc te zmiany mieszają się z pracą agentów w `git diff` reviewera i później nie da się ich już odseparować.
- **Pliki:** `plugins/aw/skills/scrum-master/SKILL.md` (sekcja intake), ewentualnie `src/commands/sm.ts`.

### 2. Briefing bez dublowania planu
- **Co:** briefing wkleja kryteria akceptacji i kontrakt, a zaraz potem każe przeczytać cały `plan.md`, który zawiera to samo. Zmienić „Read first” na: „kryteria i kontrakt są poniżej — do plan.md zajrzyj tylko po approach, test strategy i risks”.
- **Skąd:** ocena kosztu planu pilota (ok. 3,5 tys. tokenów). Dublowanie to ok. 2,5 tys. tokenów w każdym przebiegu agenta.
- **Pliki:** `src/core/briefing.ts` (sekcja „Read first”).

### 3. Tokeny per przebieg w raporcie i `aw stats`
- **Co:** z transkryptu agenta (`run.transcriptPath`, zapisywany przez hook `SubagentStop`) zsumować pola `usage` (input, output, cache) i pokazać koszt każdego przebiegu w `report.md` oraz średnie per rola w `aw stats`.
- **Uwaga:** format transkryptów nie jest oficjalnie udokumentowany. Parsowanie musi być tolerancyjne: przy nieznanym formacie pomija liczby, a nie wywala błędu.
- **Skąd:** pytanie, jak podejrzeć zużycie tokenów. W Claude Code nie ma komendy „koszt jednego prompta” (jest `/usage` dla sesji i `Done (… tokens)` po agencie).
- **Pliki:** `src/core/render.ts`, `src/commands/info.ts` (stats), `src/schema/state.ts` (pole na tokeny w runie).

### 4. Klikane decyzje przez AskUserQuestion
- **Co:** w skillu scrum-mastera przy akceptacji planu, akceptacji wyniku i blokadzie używać narzędzia AskUserQuestion z opcjami (np. „Akceptuję / Poprawki / Anuluj”) zamiast pytania na czacie. Rozmowa toczy się wtedy dalej w tej samej turze.
- **Skąd:** pytanie o „in-prompt ask” od Claude'a do użytkownika. Odłożone świadomie („nie teraz”).
- **Pliki:** `plugins/aw/skills/scrum-master/SKILL.md`.

### 5. `/aw:init` w pustym repo — zapisać zachowanie w skillu
- **Co:** dopisać do skilla jawną obsługę pustego katalogu: zapytać o stack z konkretnymi propozycjami, zapytać przed `git init`, po postawieniu projektu ponownie wykryć komendy i bramki.
- **Skąd:** w pilocie model sam tak zrobił i użytkownikowi bardzo się to podobało. Teraz to przypadek, a ma działać zawsze.
- **Pliki:** `plugins/aw/skills/init/SKILL.md`.

### 6. Obserwować: coder może edytować helpery testów
- **Co:** chronione są tylko pliki zadeklarowane przez testera (testy + `supportFiles`). Istniejące wspólne helpery (np. `test/helpers/app.ts`) coder może zmienić, żeby „ułatwić” sobie testy. Jeśli pilot to pokaże, dodać regułę: coder nie modyfikuje plików pasujących do `tests.globs` poza tymi, które sam dodaje (`testsAdded`).
- **Skąd:** przegląd konfiguracji pilota (testy tylko w `test/**`, helpery w `test/helpers/`).
- **Obserwacja z pilota:** tester sam zadeklarował helpery (`test/helpers/app.ts`, `test/helpers/users.ts`) jako `supportFiles`, więc były chronione (łącznie 5 plików). Luka dotyczy tylko plików testowych, których tester nie zadeklarował.
- **Pliki:** `src/hooks/guards.ts` (checkEdit dla codera), `src/core/validate.ts` (checkCoder).

### 7a. Mutation testing jako opcjonalna bramka po kodzie
- **Co:** zamiast mutation testingu robionego przez testera na jego własnej implementacji — opcjonalna bramka `afterCoding` (np. Stryker dla JS/TS) na prawdziwym kodzie codera, albo wynik mutacji jako dane dla reviewera kodu. Sprawdzić koszt czasowy na PGlite.
- **Skąd:** mutacje testera w pilocie (M1–M10) trafnie celowały w kryteria i ryzyka z planu, więc technika jest wartościowa, tylko robiona w złym miejscu.
- **Pliki:** `src/commands/init.ts` (wykrycie Strykera), config `gates`, `plugins/aw/agents/reviewer.md`.

### 8. Duże taski: propozycja podziału (DECYZJA: tak, wdrożyć)
- **Co:** gdy plan ma więcej niż ok. 10 kryteriów, scrum-master proponuje podział na mniejsze taski (np. users CRUD → create+get / list / patch / delete) i pyta użytkownika. Mniejsze taski to krótsze przebiegi, tańsze iteracje i łatwiejsze review.
- **Skąd:** pilot „pełne CRUD” miał 21 kryteriów, a każdy przebieg agenta był bardzo długi.
- **Pliki:** `plugins/aw/skills/scrum-master/SKILL.md` (sekcja plan), ewentualnie próg w configu.

### 9. Model, effort i limit tur per agent (PRIORYTET — limity planu)
- **Co:**
  - **Model per rola z configu repo:** `agents.<rola>.model` (np. `sonnet` / `opus` / `inherit`) → `aw sm next` wypisuje `MODEL: …` → skill scrum-mastera przekazuje go w parametrze `model` narzędzia Agent (nadpisuje frontmatter agenta). Dzięki temu każde repo może mieć własny dobór bez zmiany pluginu.
  - **Effort** da się ustawić tylko we frontmatterze agenta (`effort:`), bez nadpisania per wywołanie. Ustawić rozsądne domyślne wartości per rola zamiast dziedziczenia effortu sesji.
  - **`maxTurns`** jako bezpiecznik przed zapętleniem (po limicie agenta da się wznowić).
  - Proponowany punkt startowy: scrum-master (planowanie) i reviewer — mocny model, effort high; tester i coder — Sonnet, effort high; tryb light — Sonnet, effort medium. Zweryfikować na kolejnych taskach (`aw stats` + tokeny per przebieg z punktu 3).
- **Skąd:** pilot szedł w całości na Opus 5.5 z effortem extra high (agenci dziedziczą model sesji: `model: inherit`) i zjadał limity planu. Tester przy xhigh był wyjątkowo „dokładny” (piaskownica, mutation testing), co prawdopodobnie też wynikało z wysokiego effortu.
- **Pliki:** `src/schema/config.ts` (agents.*.model), `src/core/next.ts` (linia MODEL), `plugins/aw/skills/scrum-master/SKILL.md` (spawn z parametrem model), `plugins/aw/agents/*.md` (effort, maxTurns).

### 10. Sekcja „architektura”: decyzje (ADR) i wytyczne
- **Co:** miejsce na większe, przekrojowe decyzje, żeby nie ginęły w archiwum tasków. Dwie rzeczy:
  - **Rejestr decyzji (ADR):** co zdecydowaliśmy i dlaczego, np. ścisły regex UUID zamiast `format: 'uuid'`, walidacja body bez koercji w całej aplikacji, semantyka soft delete, unikalność emaila tylko wśród aktywnych, PGlite w testach. Plan (JSON) dostaje pole `decisions: [{ title, context, decision, consequences }]`. Użytkownik zatwierdza je razem z planem, a przy archiwizacji CLI dopisuje je do rejestru z datą i ID taska.
  - **Wytyczne:** jak robimy rzeczy w tym repo (strategia testów, format błędów, 404 vs 403, konwencje API). To stałe zasady ustalane przez użytkownika, a nie wynik jednego taska.
- **Gdzie:** tryb local — `.claude/aw/architecture.md` (albo katalog `.claude/aw/decisions/`); tryb shared — `docs/adr/`. Scrum-master czyta przy planowaniu, reviewer sprawdza zgodność zmian z rejestrem (nowa kategoria uwag `architecture`?), briefing podaje ścieżkę.
- **Skąd:** pilot users-crud przyniósł kilka decyzji o zasięgu całej aplikacji (np. AC-25: walidacja bez koercji app-wide), które dziś zostają tylko w stanie zarchiwizowanego taska. Użytkownik: „warto by było mieć sekcję na architekturę — na takie ogólne większe decyzje”.
- **Pliki:** `src/schema/outputs.ts` (PlanInput), `src/commands/sm.ts` (archive), `plugins/aw/skills/scrum-master/SKILL.md`, `plugins/aw/agents/reviewer.md`, `src/commands/init.ts` (szablon).

### 11. Kryteria akceptacji opisują zachowanie, nie strukturę (ZMIANA po decyzji użytkownika)
- **Decyzja (2026-09-28):** testy lustrzane schematu są akceptowalne i mogą zostać. Zmiany schematu są rzadkie i zwykle addytywne, więc poprawienie testu nie jest uciążliwe. **Nie** dodajemy wytycznej zakazującej testów lustrzanych. Zostaje najwyżej luźna zasada formułowania AC (zachowanie w AC, lokalizacja w kontrakcie) — do rozważenia, niski priorytet.
- **Uwaga praktyczna:** jeśli testy lustrzane mają przetrwać zmiany addytywne, powinny sprawdzać „zawiera te kolumny” (`expect.arrayContaining`), a nie „dokładnie te kolumny” (`toEqual` na pełnej liście). W pilocie test kolumn używa `toEqual`, więc dodanie kolumny go zepsuje.
- Pierwotna propozycja poniżej, zostawiona dla kontekstu:
- **Co:** zasada planowania w skillu scrum-mastera: AC opisuje obserwowalne zachowanie („druga aktywna rejestracja tego samego emaila jest odrzucana także na poziomie bazy”), a nie miejsce czy kształt implementacji („zdefiniowane w src/db/schema.ts z migracją w drizzle/”). To drugie należy do kontraktu. Do tego domyślna wytyczna dla testera: nie pisać testów, które tylko odwzorowują definicje (kolumny, typy, deklaracje indeksów w kodzie). Testować zachowanie, które wymusza baza (ograniczenia, unikalność, domyślne wartości, na których polega API).
- **Skąd:** pilot — AC-21 było sformułowane strukturalnie, więc tester napisał w `test/db/schema.test.ts` testy „lustrzane” (lista kolumn, deklaracja indeksu w schema.ts) obok wartościowych testów zachowania (unikalność bez względu na wielkość liter, częściowy indeks przy soft delete). Testy lustrzane to tzw. change-detector tests: psują się przy każdej zamierzonej zmianie schematu i dublują to, co widać w diffie migracji.
- **Pliki:** `plugins/aw/skills/scrum-master/SKILL.md` (sekcja plan), `plugins/aw/agents/tester.md`, szablon `templates/role-notes/tester.md`.

### 12. Testy: czas tracony na wielokrotnym uruchamianiu (WSTRZYMANE do apki z co najmniej 5000 testów)

**Stan na 2026-09-30** (ma pierwszeństwo przed historią niżej):
- **Etap 1 zrobiony:** `aw test` (wąskie przebiegi), blokada bezpośrednich komend testowych dla agentów, pełny zestaw raz, w bramce przy submicie.
- **M0 zrobiony:** kontrakt, plan i wyniki są w [docs/test-infra.md](docs/test-infra.md). Rozgrzany serwer testów skraca każde `aw test` o ok. 1 s; bez jawnego unieważniania zmian zwraca nieaktualne wyniki.
- **Baza testowa:** Postgres w Dockerze na Linuksie (WSL2) z danymi w RAM i `TRUNCATE` między testami. Kopia pilota przechodzi w 4,7 s zamiast 30 s (PGlite z nową bazą na test). Postgres natywnie na Windowsie i PGlite w procesie odpadają.
- **Dalsze etapy (serwer testów, tory, bazy na worker wstrzykiwane przez aw) wstrzymane** do czasu apki z co najmniej 5000 testów. Narzędzia do pomiarów są gotowe: `proto/m0-vitest/m0.mjs`, `db-matrix.mjs`, wzorzec baz na worker w `fixtures/test-aw`.
- **Projekty bez tych mechanizmów:** Postgres z Dockera i jego adres w `.env.test`. Najprostszy wariant: `fileParallelism: false`, migracje w `globalSetup`, jedno `TRUNCATE` wszystkich tabel w `beforeEach`. Bazy na worker (szablon i klony) dopiero, gdy pełny zestaw zrobi się za wolny.

**Historia ustaleń** (chronologicznie; część nieaktualna, rozstrzyga stan wyżej):
- **Problem (dane z pilota):** jeden przebieg testów trwa 33–57 s (bramki: R-1 `testFiles` 33,6 s; R-3 `test` 32,8 s; R-5 `testFiles` 56,6 s; R-7 `test` 49,5 s). Agent odpala testy wielokrotnie w trakcie pracy i czeka na nie blokująco (narzędzie Bash ma domyślnie limit 2 min, a seria mutacji testera go przekroczyła). Do kontekstu trafia pełny output testów, co kosztuje tokeny. Przebieg codera R-7 trwał 95 min — do sprawdzenia (punkt 3), ile z tego to testy, a ile czekanie na uprawnienia albo limity.
- **Etap 1 — ZROBIONY 2026-09-29** (szczegóły w „Zrobione”): `aw test`, blokada bezpośrednich komend testowych dla agentów, zasady w promptach i briefingach. Nie zrobione z etapu 1: `--related` (testy dotknięte zmienionymi plikami źródłowymi) — do rozważenia przy etapie 2.
- **Ustalenia z planowania (2026-09-29):**
  - kierunek: zamiast klasycznego watch **serwer testów na żądanie** — proces Node z vitestem jako biblioteką (nie komenda CLI), trzymający moduły w pamięci; `aw test` rozmawia z nim przez lokalne HTTP (127.0.0.1). Do potwierdzenia przez użytkownika po wyjaśnieniach;
  - start serwera: **oba tryby** — automatycznie przez `aw test` albo ręcznie w terminalu użytkownika (wtedy `aw test` używa jego serwera);
  - kolejność: **najpierw prototyp M0** (API vitesta w Node na wersji z projektu: odpalanie wybranych plików z `-t` na żądanie, odświeżanie zmienionych modułów, wyniki w strukturze, pomiar zysku);
  - *(nieaktualne: później wybrane wstrzykiwanie setupu w locie, niżej)* izolacja baz: decyzja odłożona — użytkownik prosił o prostsze wyjaśnienie problemu. Ważne: w trybie widmo każda opcja izolacji baz wymaga zmiany w setupie testów projektu (widocznej dla zespołu), więc M2 dotyczy głównie własnych projektów albo repo, w których zespół się zgodzi;
  - env: aw dodaje wyłącznie zmienne `AW_*`, nigdy nie nadpisuje zmiennych projektu (np. `DATABASE_URL`); serwer używa tej samej konfiguracji co zwykłe testy (`vitest.config.*`, `.env.test`) i restartuje się, gdy zmienią się pliki konfiguracyjne/env (odcisk plików zapisany przy starcie);
  - `TRUNCATE` kosztuje głównie od liczby tabel, nie od ilości danych; pułapka: dane słownikowe z migracji — lista tabel do pominięcia albo ponowny seed.
  - **klucze obce:** czyścić wszystkie tabele **jednym** poleceniem `TRUNCATE a, b, c … RESTART IDENTITY`, z listą tabel generowaną z katalogu bazy (bez tabeli migracji i tabel „do zachowania”). Wtedy kolejność nie ma znaczenia, bo FK między tabelami z listy Postgres obsługuje sam. Bez `CASCADE`: gdyby tabela „do zachowania” wskazywała na czyszczoną, Postgres zgłosi błąd głośno, zamiast po cichu wyczyścić to, co miało zostać. (Problem z kolejnością znany użytkownikowi dotyczy `DELETE` albo czyszczenia tabel osobnymi poleceniami.)
  - **jeden Postgres, wiele baz:** jeden kontener (jeden serwer) mieści wszystkie bazy torów i workerów; `CREATE DATABASE` nie tworzy nowej instancji. Pamięć rośnie głównie z liczbą połączeń (kilka MB na połączenie), nie z liczbą baz → małe pule połączeń w testach. Przyspieszenie testowego Postgresa: dane na `tmpfs` (RAM) + `fsync=off`, `synchronous_commit=off`, `full_page_writes=off` (trwałość niepotrzebna). Do rozważenia: `aw db up` z gotowym plikiem compose.
  - **wymaganie użytkownika: zero zmian w projekcie pod aw** („nie podoba mi się dodawanie do projektu czegoś specyficznego pod plugin Claude Code”). Kierunek: **wstrzykiwanie setupu w locie**. Serwer testów aw (i bramki uruchamiane przez runner aw) dokłada przez API vitesta własny plik setupu z pluginu (przed setupem projektu): wybiera bazę workera, klonuje szablon, ustawia zmienną z adresem bazy (konfigurowalna nazwa, np. `DATABASE_URL`), czyści tabele (domyślnie per plik testów, opcjonalnie per test; lista tabel do zachowania w configu). Repo zostaje nietknięte, a `npm test` uruchomiony ręcznie działa jak dotąd. Warunki: projekt bierze adres bazy ze zmiennej w czasie działania; testy nie zakładają danych przetrwałych między plikami; przy własnym zarządzaniu bazą w `globalSetup` (np. testcontainers) funkcję się wyłącza.
  - **pomysł użytkownika: osobny `/aw:init-tests` + spisany kontrakt.** Konfigurację infrastruktury testów robi osobny skill, a o sukcesie decyduje kod: kontrakt (lista właściwości) i komenda `aw test-infra verify`, która sprawdza każdą właściwość i zwraca ✓/✗. LLM może tylko zmieniać config i poprawiać, aż weryfikacja przejdzie (albo zgłosić blokadę). Wykrywanie ORM-u, zmiennych env i komend jest kodem; LLM tylko uzupełnia to, czego kod nie rozstrzygnął. Proponowane punkty kontraktu: te same wyniki co zwykły przebieg; brak wzajemnego wpływu dwóch torów uruchomionych równocześnie; świeżość (zmiana pliku widoczna w następnym przebiegu); szablon zgodny z aktualnym hashem migracji; testy nie dotykają domyślnej bazy z `.env.test` (liczniki `pg_stat_database` bez zmian); zero zmian w repo (`git status` przed = po); sprzątanie baz torów; pomiar czasu (informacyjnie).
  - **wykrywanie komendy migracji (deterministyczne):** najpierw skrypt projektu z `package.json` o znanej nazwie (`db:migrate`, `migrate`, `migration:run`…), dopiero potem wpisana na sztywno tabela ORM-ów (zależność → komenda + tabela migracji). Nieznany ORM → brak wykrycia → `init-tests` pyta, a weryfikacja rozstrzyga.
  - **sonda świeżości (punkt 3 kontraktu):** aw tworzy tymczasowy plik testu (nazwa `__aw_probe__`, rozszerzenie jak w istniejących testach, katalog pasujący do `include` vitesta) oraz tymczasowy moduł źródłowy z wartością; test sprawdza tę wartość. Przebieg 1: zaliczony. aw zmienia wartość w module źródłowym → przebieg 2: oblany. Dowodzi odświeżania zmienionych modułów. Sprzątanie w `finally`, a pozostałości po awarii usuwa kolejne uruchomienie po wzorcu nazwy; `git status` przed = po.
  - **świeżość wyników w trybie watch (pomysł użytkownika — ma sens):** przebieg jest świeży, gdy wystartował po ostatniej modyfikacji istotnych plików **i** żaden plik nie zmienił się w trakcie przebiegu (sprawdzenie na końcu). Wynik nieświeży jest oznaczany, a nie ukrywany.
  - **CPU nie jest ograniczeniem** (i9 13. gen / Mac M3 Pro) — argument kosztowy przeciw stałym przebiegom w tle odpada; zostaje kwestia nieaktualnych wyników, rozwiązywana regułą świeżości.
  - **DECYZJA użytkownika (2026-09-29) — dwa rodzaje torów:** (1) **tor żądań**: pliki i filtr z `aw test`, na żądanie; (2) **tor taska**: wszystkie pliki testów taska (chronione i zadeklarowane), odpalane automatycznie przy zmianach, z regułą świeżości; `aw test` dołącza ostatni świeży wynik toru taska. Plus bramka z pełnym zestawem przy submicie. Uzasadnienie: oszczędność czasu, a jeśli coś nie działa, któryś tor to pokaże.
  - **realistyczny zysk z rozgrzanego serwera (do zmierzenia w M0):** serwer oszczędza stały koszt każdego uruchomienia (start `npx`/Node, ładowanie vitesta i vite, config, pula workerów, `globalSetup`, ponowne kompilowanie niezmienionych plików), ale **nie** skraca samych testów. W `test-aw` dominują testy: ~0,24 s na test, głównie kopia bazy PGlite na każdy test. Hipoteza: największy zysk w tym projekcie da Postgres z `TRUNCATE` zamiast kopii bazy na test (ms zamiast ~200 ms na test), a serwer — przy wielu krótkich, zawężonych uruchomieniach. M0 mierzy osobno: narzut zimnego startu, czas przebiegu na rozgrzanym serwerze, koszt setupu na test.
  - **pomysł użytkownika: stałe przebiegi w tle** (watch wszystkich testów na osobnej bazie; drugi tor na chronionych testach taska). Na razie **nie domyślnie**: stałe przebiegi zabierają CPU agentom i wracają do problemu nieaktualnych wyników. Opcja na później: **tor regresji** — pełny zestaw w tle po udanym wąskim `aw test` albo w bezczynności; `aw test` dopisuje „w tle: 3 porażki w innych plikach (sprzed 2 min)”, żeby coder widział regresje przed submitem.
  - **`aw db up` — użytkownikowi bardzo się podoba:** gotowy compose z Postgresem na `tmpfs` i wyłączoną trwałością.
  - **zakres M0 (rozszerzony):** vitest z `node_modules` projektu (jego wersja); ta sama konfiguracja co CLI (`vitest.config.*`, setupFiles, env z configu); odpalanie wybranych plików z filtrem nazw na żądanie; odświeżanie zmienionych modułów; wyniki przez reporter; **wstrzyknięcie dodatkowego setupFile przez API**; zachowanie `globalSetup` w długo żyjącym procesie; pomiar czasu vs zimny `npx vitest run`.
  - **aplikacja w Dockerze z entrypointem aw — odrzucone (2026-09-29):** serwer testów działa na hoście (WSL); w Dockerze tylko Postgres. Powody: bind-mount źródeł i obserwowanie plików bywają wolne/zawodne, konflikty `node_modules` host/kontener, przebudowy przy zmianie zależności, a automatyczne generowanie działającego Dockerfile dla dowolnego repo (frameworki, monorepo, prywatne rejestry, istniejące Dockerfile zespołu) nie jest realne deterministycznie. Projekty, które już mają swoje kontenery, mogą je podpiąć przez konfigurowalne `commands`.
- **Kontrakt i plan etapu 2: [docs/test-infra.md](docs/test-infra.md)** (spisane 2026-09-29). To źródło prawdy dla M0–M3; notatki w tym punkcie to historia ustaleń. Prototyp M0: [proto/m0-vitest/m0.mjs](proto/m0-vitest/m0.mjs).
- **M0 zrobiony 2026-09-29:** wszystkie punkty ✓ (K1, K2, K6, wstrzyknięcie, globalSetup). Wyniki i wnioski są w sekcji „Wyniki M0” w [docs/test-infra.md](docs/test-infra.md). W skrócie: serwer skraca każde wywołanie `aw test` o ok. 0,8–1 s, niezależnie od liczby testów; jawne unieważnianie zmian jest konieczne (bez niego serwer zwraca nieaktualny wynik). Materiał do kolejnych etapów: kopia pilota w [fixtures/test-aw](fixtures/README.md) (users.test.ts rozbity na 5 plików, baza testów przełączana: PGlite/Postgres × nowa baza/`TRUNCATE`). PGlite z `TRUNCATE` zamiast nowej bazy na test: pełny zestaw 7,6 s zamiast 25,8 s.
- **Porównanie PGlite z osobnym Postgresem (zrobione 2026-09-30, `proto/m0-vitest/db-matrix.mjs`):** najszybszy jest Postgres 18 w Dockerze w WSL2 z danymi w RAM (`fixtures/test-aw/docker-compose.yml`, port 5433): pełny zestaw 4,7 s wobec 30 s dla PGlite z nową bazą na test i 8,4 s dla PGlite z `TRUNCATE`. Postgres natywnie na Windowsie (port 6969, trwałość wyłączona) jest najwolniejszy: 12,6–62 s. Szczegóły w docs/test-infra.md („Baza w testach”).
- **Decyzje użytkownika (2026-09-30):**
  - Baza testowa to Postgres w Dockerze na Linuksie (WSL2) z danymi w RAM. Postgres natywnie na Windowsie odpada, bo jest najwolniejszy. PGlite w procesie też nie jest kierunkiem.
  - Dalsza eksploracja etapu 2 (serwer testów, tory, porównania) wstrzymana do czasu apki z co najmniej 5000 testów. Przy 250 testach różnice to sekundy, a efekty skali (wiele workerów na jednym Postgresie, większy graf importów, cięższe testy) nie wychodzą. Wtedy porównanie tymi samymi narzędziami: `proto/m0-vitest/db-matrix.mjs`, `m0.mjs`, wzorzec z `fixtures/test-aw`. Tę apkę można budować przez aw jako dalszy pilot workflow.
- **Etap 2 „na maksa”, deterministycznie** (decyzja użytkownika): „Już takiego dowalonego na maksa, czyli z postgresem, snapshotami, wieloma instancjami — o ile się to da ogarnąć… DETERMINISTYCZNIE”.
- **Etap 2 (watch na hoście):** `aw watch` uruchamia runner w trybie watch — w terminalu użytkownika albo w tle, przez scrum-mastera — z reporterem aw, który zapisuje `.tasks/test-status.json`: `{ state: running|passed|failed, runStartedAt, finishedAt, files, counts, failures: [{ file, test, message (przycięty) }] }`. Agenci zamiast odpalać testy wołają `aw test` (status plus informacja, czy wynik jest świeży) albo `aw test --wait` (czeka na przebieg, który wystartował po ostatniej zmianie plików i po krótkiej chwili ciszy; timeout poniżej 2 min). Gdy watcher nie działa, `aw test` sam odpala testy, więc pipeline od niego nie zależy.
- **Świeżość:** wynik liczy się tylko, gdy przebieg wystartował po najnowszej modyfikacji plików `src`/`test` (mtime). Inaczej agent czytałby wynik dla starego kodu. Watch rusza przy każdym zapisie, także przy niedokończonych zmianach, stąd „chwila ciszy”.
- **Bramka przy submicie zostaje autorytatywna** (CLI sam uruchamia testy): plik statusu da się podrobić, a to tylko jeden przebieg na submit.
- *(nieaktualne: pomiar z 2026-09-30 — Postgres w RAM z `TRUNCATE` skraca pełny zestaw ok. 6×)* **Realistyczny zysk:** głównie tokeny (krótkie podsumowanie zamiast pełnego outputu), brak czekania na zimny start i koniec wielokrotnego puszczania pełnego zestawu. Sam czas wykonania testów zmieni się niewiele, bo dominują testy, nie start runnera; na to działa etap 1 i szybsze testy (tester w pilocie przyspieszył setup bazy ok. 4× szablonem PGlite).
- **Zależność od runnera:** reporter najpierw dla vitest (obsługuje własne reportery z pliku), jest później.
- **Uruchamianie watchera ma być deterministyczne, nie decyzją modelu:** `aw test` sprawdza pid i heartbeat; gdy watch jest włączony w configu, a watcher nie żyje, uruchamia go jako odłączony proces w tle (log w `.tasks/watch.log`) i czeka na pierwszy wynik. `aw watch stop` go zatrzymuje, `aw sm archive` sprząta. Alternatywa: użytkownik sam odpala `aw watch` w swoim terminalu. Opcjonalnie hook blokuje agentom aw bezpośrednie `npm test` / `npx vitest`, gdy watch jest włączony („użyj `aw test`”).
- **Priorytet użytkownika (2026-09-29):** chodzi o czas tracony na wielokrotnym odpalaniu testów, a nie o surowy czas jednego przebiegu.
- *(częściowo nieaktualne: projekt zostaje na Windowsie, w Dockerze w WSL2 działa tylko Postgres)* **Plan użytkownika:** projekt na systemie plików Linuksa (WSL) i testy na prawdziwym Postgresie w Dockerze, czyszczonym przez `TRUNCATE` między testami. **Pułapka:** watcher, bramka przy submicie i równoległe pliki testów nie mogą dzielić jednej bazy, bo `TRUNCATE` jednego procesu wyczyści dane drugiemu. Każdy proces/worker musi dostać własną bazę z szablonu (`CREATE DATABASE test_<pid>_<worker> TEMPLATE app_template`), a w jej obrębie `TRUNCATE`. Przy PGlite problemu nie ma (baza w pamięci procesu).
- **Do sprawdzenia:** komponent pluginu `monitors` w Claude Code — czy nadaje się do przekazywania zdarzeń watchera do sesji.
- **Pliki (etap 1, zrobione; reporter niezrobiony):** nowe `src/commands/test.ts` i reporter w `plugins/aw/`, `src/schema/config.ts` (commands), prompty agentów, `plugins/aw/skills/init/SKILL.md` (wykrywanie runnera).

### 13. Przegląd czytelności reszty kodu
- **Co:** przejść `src/` plik po pliku według nowych zasad z CLAUDE.md („Conventions”). Główne miejsca:
  - jednoliterowe nazwy (`s` dla stanu w callbackach `mutate`, `r` dla przebiegu, `p`, `f`) — w prawie każdym pliku;
  - gęste jednolinijkowce w `core/validate.ts`, `core/briefing.ts`, `core/render.ts`;
  - zagnieżdżone ternary w `commands/role.ts` (`complete`, `gatesFor`, tworzenie przebiegu w `start`);
  - długie linie z logiką i tekstem naraz.
- **Skąd:** review użytkownika 2026-09-29: „Całkiem spoko jest ten kod. Ale średnio czytelny tak o dla człowieka”. Naprawione od razu: literały trybu blokady testów (`DirectTestCommands` + `directTestCommandsBlocked`), ad-hoc unie ról (`Role`), strażnik testów (`findTestRunnerCall` z opisem i przykładami), `any` w testach (typowane helpery).
- **Jak:** plik po pliku, żeby dało się to przejrzeć; zachowanie bez zmian (testy muszą przejść bez modyfikacji asercji).

## Po pilocie — do sprawdzenia
- Czy limity iteracji (3/3) są rozsądne przy dużym tasku, czy task wpadł w BLOCKED.
- Ile kosztowały poszczególne etapy (linie `Done (… tokens)`, `/usage` przed/po).
- Ile było okien uprawnień i czy reguły z `/aw:init` wystarczyły.
- Jakość `report.md`: czego brakuje, co zbędne.
- `processNotes` agentów: co im przeszkadzało.

## Na później (opcjonalne)
- **Źródła CLI do katalogu `cli/`**, żeby root był czystym marketplace'em. Czysto porządkowe, warto dopiero przy drugim pluginie albo narzędziu w repo.

## Zrobione
- 2026-09-29: **standardy kodu dla agentów.** Domyślne standardy w `plugins/aw/templates/code-standards.md` (opisowe nazwy, bez zagnieżdżonych ternary, nazwane funkcje dla nieoczywistych warunków, wspólne typy zamiast literałów, bez `any` także w testach) plus reguły repo w `.claude/aw/code-standards.md` (szablon z `aw init`). Oba trafiają do briefingu codera, testera i reviewera; reguły repo wygrywają. Reviewer zgłasza naruszenia (`readability`/`conventions`, zwykle `minor`). Kontekst: review użytkownika — te same zasady obowiązują w kodzie samego pluginu (CLAUDE.md).
- 2026-09-29: **coder a niekompletne testy.** Coder ma jawne ścieżki: błędny test → `testDisputes`; brakujący przypadek → nowy test w nowym pliku (`testsAdded`) i opis luki w `processNotes`; niejasne wymagania → `openQuestions`. Kontekst: pytanie użytkownika „nie za bardzo blokujące? nie może się zdarzyć, że test nie jest pełny?”.
- 2026-09-29: (etap 1 punktu 12) **czas testów.** Nowa komenda `aw test [pliki] [-t "<nazwa>"]`: odpala testy tego taska (chronione, zadeklarowane przez testera i codera, pliki testowe zmienione od startu taska), zawęża po nazwie (`commands.testFiltered` albo doklejone `-t`), wypisuje zwięzły wynik i czas, a pełny log zapisuje w `logs/`. Każde wywołanie zapisuje się w przebiegu agenta (`runs[].testRuns`), a czas testów per przebieg i per rola pokazują `report.md` i `aw stats`. Hook blokuje agentom aw bezpośrednie komendy runnera (`npm test`, `npx vitest`, komendy `commands.test*`…) z odesłaniem do `aw test`; wyłącznik: `guards.directTestCommands: "allow"`. Prompty i briefingi: coder i tester odpalają wąsko, pełny zestaw uruchamia bramka przy submicie; reviewer nie odpala testów ponownie (wyniki bramek w briefingu są wiążące), wolno mu tylko wąskie `aw test`. `aw doctor` sprawdza `commands.testFiles`; `aw init` ustawia `testFiltered` dla mocha i `node --test`. Kontekst: pełny zestaw w pilocie trwał ok. 56 s (69 s z uruchomieniem), a agenci — także reviewerzy — puszczali go wielokrotnie.
- 2026-09-29: (dawny punkt 7) agenci wiedzą, że pracują jako zespół czterech ról w cyklu TDD — sekcja „The team” w `tester.md`, `coder.md`, `reviewer.md` i zdanie w skillu scrum-mastera. Tester ma twardą zasadę: nigdy nie buduje testowanego featureu, nigdzie (także w piaskownicy), bez mutation testingu na własnym kodzie, bez `npm install`; sprawdza tylko, że jego testy failują z właściwego powodu, odpalając własne pliki, a nie cały zestaw. Przypomnienie w briefingu testera (`src/core/briefing.ts`). Reviewer traktuje wyjście poza rolę (tester z kodem produkcyjnym, coder zmieniający testy) jako uwagę. Egzekwowanie tylko przez prompt — decyzja użytkownika, scratchpad może służyć innym celom. Kontekst: w pilocie tester zbudował implementację w kopii projektu i robił na niej mutation testing (pierwsza iteracja 30 min).
- 2026-09-28: pole `symbol` w uwagach reviewera + informacja, że numery linii to podpowiedź (linie przesuwają się po zmianach codera).
- 2026-09-28: w repo bez aw hook blokuje agentów `aw:*` (wcześniej mieli tylko miękką instrukcję).
- 2026-09-28: tryb „widmo” jako domyślny w `aw init` (`.git/info/exclude`, `CLAUDE.local.md`), flaga `--shared`.
- 2026-09-28: uwagi użytkownika po review jako osobne notatki; `reopen` wymaga notatek; reviewer weryfikuje odpowiedzi.
