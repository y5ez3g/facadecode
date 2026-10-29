# Jak współtworzyć Facade Code

Dziękujemy za pomoc. Facade Code jest rozwijane otwarcie na [github.com/y5ez3g/facadecode](https://github.com/y5ez3g/facadecode).

## Błędy i pomysły

Otwórz [issue](https://github.com/y5ez3g/facadecode/issues); Help > Report Issue (Pomoc > Zgłoś problem) otwiera nowe zgłoszenie z już wpisaną wersją. Najpierw przeszukaj istniejące zgłoszenia, a w przypadku błędu napisz:

- co zrobiłeś, czego się spodziewałeś i co stało się zamiast tego;
- wersję z Help > About (Pomoc > Informacje) i swój system operacyjny;
- przy problemie z agentem: które CLI agenta i w jakiej wersji.

Luk bezpieczeństwa nie zgłasza się w issues; zobacz [`SECURITY.md`](SECURITY.md).

## Kod

Jak pracujemy w tym repozytorium, opisuje [`docs/ide/ENGINEERING.md`](../../ide/ENGINEERING.md): jak przygotować build, jakie polecenia sprawdzają zmianę, a także pełną treść poniższych zasad.

- Twórz gałąź od `main` jako `feature/<name>`.
- Merge, nigdy rebase: funkcja trafia do `main` przez `--no-ff`, po przeglądzie kodu.
- Trzymaj pliki Facade Code razem, a w plikach VS Code dodawaj opcjonalne hooki zamiast przepisywać ich logikę, żeby scalanie nowszych wersji VS Code wymagało mniej pracy.
- Każda funkcja ma przełącznik; po jej wyłączeniu VS Code działa jak oryginał.
- Do każdej zmiany dołącz testy.
- Dokumentację, komentarze i opisy commitów pisz po angielsku.

Co ma robić każda funkcja, opisano w [`docs/ide/`](../../ide/). Żeby zmienić zachowanie, zacznij od specyfikacji albo najpierw otwórz issue, żeby to omówić.

## Licencja

Wnosząc wkład, zgadzasz się, że jest on licencjonowany na warunkach [licencji MIT](../../../LICENSE.txt) projektu.
