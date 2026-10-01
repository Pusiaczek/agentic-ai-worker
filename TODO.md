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
- **Pliki:** `src/hooks/guards.ts` (checkEdit dla codera), `src/core/validate.ts` (checkCoder).

### 7. Tester: sprawdza testy, nie buduje featureów (DECYZJA: tak, wdrożyć po pilocie)
- **Co:** w `tester.md` zapisać twardą zasadę: **tester nie wykonuje żadnej weryfikacji, która wymaga zbudowania testowanego featureu — nigdzie** (ani w repo, ani w piaskownicy/scratchpadzie, ani jako „robocza” implementacja). Budowanie featureu to wyłącznie rola codera; tester jest testerem, nie coderem. Wolno mu: uruchamiać własne testy, sprawdzać, że się kompilują/importują i failują z właściwego powodu (brak zachowania, a nie błąd w teście). Nie robi mutation testingu na własnym kodzie i nie uruchamia `npm install`. Jeśli bez implementacji nie da się sensownie sprawdzić testu — opisuje to w `processNotes`, a weryfikację zostawia reviewerowi i bramkom po kodzie. Wdrożyć dopiero po pilocie, żeby nie zmieniać reguł w trakcie.
- **Egzekwowanie: tylko prompt, bez heurystyki w hooku** (decyzja użytkownika — scratchpad może służyć testerowi do innych, uprawnionych rzeczy). Zasada w `tester.md` (prompt systemowy — zawsze obecny) + jedno zdanie przypomnienia w briefingu testera w sekcji „Your job” (`src/core/briefing.ts`, `testerSection`), żeby była świeża w kontekście każdego przebiegu.
- **Skąd:** w pilocie tester zbudował kopię projektu w scratchpadzie (junction do prawdziwego `node_modules`), napisał tam pełną implementację i ręcznie zrobił mutation testing (10 mutacji przez `sed`). Merytorycznie dobre, ale to budowanie featureu przed coderem. Pierwsza iteracja: 17+ min, 111k+ tokenów. Użytkownik: „niech sobie coś tam sprawdza, ale niech nie buduje featureów… to trochę mija się z celem”.
- **Dodatkowe ryzyko:** komendy w piaskownicy miały `cd "$SP" && …` tylko w pierwszej linii. Gdyby `cd` się nie udało, kolejne linie (cp/sed) zadziałałyby w repo.
- **Pliki:** `plugins/aw/agents/tester.md`.

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

## Po pilocie — do sprawdzenia
- Czy limity iteracji (3/3) są rozsądne przy dużym tasku, czy task wpadł w BLOCKED.
- Ile kosztowały poszczególne etapy (linie `Done (… tokens)`, `/usage` przed/po).
- Ile było okien uprawnień i czy reguły z `/aw:init` wystarczyły.
- Jakość `report.md`: czego brakuje, co zbędne.
- `processNotes` agentów: co im przeszkadzało.

## Na później (opcjonalne)
- **Źródła CLI do katalogu `cli/`**, żeby root był czystym marketplace'em. Czysto porządkowe, warto dopiero przy drugim pluginie albo narzędziu w repo.

## Zrobione
- 2026-09-28: pole `symbol` w uwagach reviewera + informacja, że numery linii to podpowiedź (linie przesuwają się po zmianach codera).
- 2026-09-28: w repo bez aw hook blokuje agentów `aw:*` (wcześniej mieli tylko miękką instrukcję).
- 2026-09-28: tryb „widmo” jako domyślny w `aw init` (`.git/info/exclude`, `CLAUDE.local.md`), flaga `--shared`.
- 2026-09-28: uwagi użytkownika po review jako osobne notatki; `reopen` wymaga notatek; reviewer weryfikuje odpowiedzi.
