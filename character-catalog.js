/** Wspólny katalog postaci (seed SQLite i PostgreSQL). */

function avatarUrl(name) {
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=6d2c1a&color=fffaf5&size=512&bold=true`;
}

export const DEFAULT_TYPICAL_HOURS = {
  zofia: ["10:00", "14:00"],
  halina: ["14:00", "18:00"],
  danuta: ["09:00", "13:00"],
  irena: ["18:00", "22:00"],
  grazyna: ["11:00", "15:00"],
  elzbieta: ["08:00", "12:00"],
  teresa: ["16:00", "20:00"],
  krystyna: ["12:00", "16:00"],
  andrzej: ["15:00", "19:00"],
  marek: ["17:00", "21:00"],
  pawel: ["09:00", "12:00"],
  tomasz: ["13:00", "17:00"],
  monika: ["11:00", "15:00"],
  katarzyna: ["15:00", "19:00"],
  agnieszka: ["18:00", "22:00"],
  michal: ["10:00", "13:00"],
  piotr: ["12:00", "16:00"],
  anna: ["09:00", "13:00"],
  magdalena: ["14:00", "18:00"],
  krzysztof: ["17:00", "21:00"],
  robert: ["08:00", "12:00"],
  barbara: ["18:00", "22:00"],
  renata: ["13:00", "17:00"],
};

export const CHARACTER_PORTRAITS = {
  zofia: avatarUrl("Wróżka Zofia"),
  halina: avatarUrl("Wróżka Halina"),
  danuta: avatarUrl("Wróżka Danuta"),
  irena: avatarUrl("Wróżka Irena"),
  grazyna: avatarUrl("Wróżka Grażyna"),
  elzbieta: avatarUrl("Wróżka Elżbieta"),
  teresa: avatarUrl("Wróżka Teresa"),
  krystyna: avatarUrl("Wróżka Krystyna"),
  andrzej: avatarUrl("Wróżbita Andrzej"),
  marek: avatarUrl("Wróżbita Marek"),
  pawel: avatarUrl("Wróżbita Paweł"),
  tomasz: avatarUrl("Wróżbita Tomasz"),
  monika: avatarUrl("Tarocistka Monika"),
  katarzyna: avatarUrl("Tarocistka Katarzyna"),
  agnieszka: avatarUrl("Tarocistka Agnieszka"),
  michal: avatarUrl("Tarocista Michał"),
  piotr: avatarUrl("Tarocista Piotr"),
  anna: avatarUrl("Astrolog Anna"),
  magdalena: avatarUrl("Astrolog Magdalena"),
  krzysztof: avatarUrl("Astrolog Krzysztof"),
  robert: avatarUrl("Astrolog Robert"),
  barbara: avatarUrl("Jasnowidzka Barbara"),
  renata: avatarUrl("Jasnowidzka Renata"),
};

export const CHAR_ABOUT = {
  zofia: {
    gender: "kobieta",
    skills: "jasnowidzenie, rytuały księżycowe, oczyszczanie energii",
    about:
      "Od wielu lat pracuję z energią i intuicją, która prowadzi mnie do prawdy ukrytej przed innymi. Widzę blokady, które zatrzymują Cię w miejscu, oraz możliwości, które możesz jeszcze wykorzystać. W swojej pracy korzystam z rytuałów księżycowych i oczyszczania energetycznego, aby przywrócić równowagę i harmonię w Twoim życiu. Pomagam w sprawach miłosnych, rodzinnych i życiowych decyzjach.",
  },
  halina: {
    gender: "kobieta",
    skills: "miłość, karty klasyczne, intuicja",
    about:
      "Specjalizuję się w sprawach serca i relacji. Moje karty pokazują prawdziwe intencje drugiej osoby oraz przyszłość związku. Pomagam zrozumieć emocje, podjąć decyzję i odnaleźć spokój w trudnych sytuacjach uczuciowych.",
  },
  danuta: {
    gender: "kobieta",
    skills: "numerologia, przeznaczenie, analiza życia",
    about:
      "Liczby są dla mnie mapą Twojego życia. Analizuję datę urodzenia i imię, aby odkryć Twoje talenty, przeznaczenie i nadchodzące zmiany. Pomagam lepiej zrozumieć siebie i podejmować właściwe decyzje.",
  },
  irena: {
    gender: "kobieta",
    skills: "kontakt z duchowymi przewodnikami, przekazy",
    about:
      "Jestem medium, które odbiera przekazy od przewodników duchowych. Dzięki temu mogę wskazać Ci drogę, rozwiać wątpliwości i pomóc odnaleźć sens w trudnych doświadczeniach.",
  },
  grazyna: {
    gender: "kobieta",
    skills: "rytuały ochronne, zdejmowanie negatywnej energii",
    about:
      "Pracuję z energią ochronną i oczyszczającą. Pomagam zdjąć negatywne wpływy, złe życzenia i blokady, które mogą wpływać na Twoje życie. Przywracam spokój i bezpieczeństwo.",
  },
  elzbieta: {
    gender: "kobieta",
    skills: "magia natury, uzdrawianie energetyczne",
    about:
      "Czerpię siłę z natury i energii ziemi. Pomagam odzyskać równowagę emocjonalną, wewnętrzny spokój i siłę do działania. Wspieram w trudnych momentach życiowych.",
  },
  teresa: {
    gender: "kobieta",
    skills: "wizje przyszłości, intuicja",
    about:
      "Widzę możliwe scenariusze przyszłości i pomagam wybrać ten najlepszy. Moje odczyty są szczere i konkretne – pokazuję zarówno szanse, jak i zagrożenia.",
  },
  krystyna: {
    gender: "kobieta",
    skills: "relacje, analiza sytuacji życiowych",
    about:
      "Pomagam spojrzeć na Twoją sytuację z dystansu. Analizuję relacje, konflikty i decyzje, abyś mógł/mogła świadomie działać i odzyskać kontrolę nad swoim życiem.",
  },
  andrzej: {
    gender: "mężczyzna",
    skills: "jasnowidzenie, ochrona energetyczna",
    about:
      "Moje wizje są konkretne i trafne. Pomagam przewidzieć rozwój wydarzeń oraz uniknąć błędów. Wspieram również w ochronie energetycznej.",
  },
  marek: {
    gender: "mężczyzna",
    skills: "tarot, analiza karmy",
    about:
      "Łączę tarot z analizą karmicznych powiązań. Pomagam zrozumieć, dlaczego pewne sytuacje się powtarzają i jak je zakończyć.",
  },
  pawel: {
    gender: "mężczyzna",
    skills: "intuicja, decyzje życiowe",
    about:
      "Pomagam podejmować trudne decyzje życiowe. Moje odczyty są jasne, szczere i konkretne – bez zbędnych niedomówień.",
  },
  tomasz: {
    gender: "mężczyzna",
    skills: "runy, przewidywanie przyszłości",
    about:
      "Runy są moim narzędziem pracy. Odpowiadam na konkretne pytania i wskazuję możliwe rozwiązania problemów.",
  },
  monika: {
    gender: "kobieta",
    skills: "tarot miłosny, relacje",
    about:
      "Specjalizuję się w tarocie miłosnym. Odczytuję uczucia, intencje i przyszłość relacji. Pomagam zrozumieć partnera i podjąć decyzję.",
  },
  katarzyna: {
    gender: "kobieta",
    skills: "tarot psychologiczny",
    about:
      "Łączę tarot z analizą emocji. Pomagam zrozumieć Twoje reakcje, lęki i potrzeby, abyś mógł/mogła iść dalej świadomie.",
  },
  agnieszka: {
    gender: "kobieta",
    skills: "tarot duchowy, rozwój",
    about:
      "Tarot to dla mnie narzędzie rozwoju. Pokazuję Twoje możliwości i kierunki, które warto wybrać.",
  },
  michal: {
    gender: "mężczyzna",
    skills: "tarot klasyczny, szybkie odpowiedzi",
    about:
      "Stawiam na konkret i jasność przekazu. Odpowiadam szybko i trafnie na zadane pytania.",
  },
  piotr: {
    gender: "mężczyzna",
    skills: "relacje, decyzje",
    about:
      "Analizuję sytuacje życiowe i relacje. Pomagam znaleźć rozwiązanie i wyjście z trudnych sytuacji.",
  },
  anna: {
    gender: "kobieta",
    skills: "horoskop urodzeniowy",
    about:
      "Analizuję Twój horoskop urodzeniowy i pokazuję Twoje mocne strony, wyzwania oraz cykle życia.",
  },
  magdalena: {
    gender: "kobieta",
    skills: "relacje, tranzyty planet",
    about:
      "Pomagam zrozumieć wpływ planet na Twoje życie i relacje. Wskażę najlepszy moment na działanie.",
  },
  krzysztof: {
    gender: "mężczyzna",
    skills: "astrologia karmiczna",
    about:
      "Analizuję Twoją przeszłość i karmiczne powiązania zapisane w horoskopie.",
  },
  robert: {
    gender: "mężczyzna",
    skills: "finanse, praca",
    about:
      "Pomagam podejmować decyzje zawodowe i finansowe w oparciu o układ planet.",
  },
  barbara: {
    gender: "kobieta",
    skills: "wizje przyszłości",
    about:
      "Widzę obrazy przyszłości i możliwe wydarzenia. Pomagam przygotować się na nadchodzące zmiany.",
  },
  renata: {
    gender: "kobieta",
    skills: "odczyty energetyczne",
    about:
      "Czytam energię ludzi i sytuacji. Odkrywam to, co ukryte i niewidoczne na pierwszy rzut oka.",
  },
};

export const EXTRA_OR_BASE_ROWS = [
  ["zofia", "Wróżka Zofia", "Widzę Twoje blokady i pomagam odzyskać harmonię oraz właściwy kierunek.", "Wróżby", 10],
  ["halina", "Wróżka Halina", "Odczytam uczucia i przyszłość Twojej relacji.", "Wróżby", 20],
  ["danuta", "Wróżka Danuta", "Z liczb odczytam Twoje przeznaczenie i życiową drogę.", "Wróżby", 30],
  ["irena", "Wróżka Irena", "Przekazuję wskazówki od przewodników duchowych.", "Wróżby", 40],
  ["grazyna", "Wróżka Grażyna", "Oczyszczam z negatywnej energii i przywracam spokój.", "Wróżby", 50],
  ["elzbieta", "Wróżka Elżbieta", "Przywracam równowagę i wzmacniam Twoją energię.", "Wróżby", 60],
  ["teresa", "Wróżka Teresa", "Pokazuję przyszłość i pomagam wybrać najlepszą drogę.", "Wróżby", 70],
  ["krystyna", "Wróżka Krystyna", "Pomagam zrozumieć sytuację i podjąć właściwą decyzję.", "Wróżby", 80],
  ["andrzej", "Wróżbita Andrzej", "Widzę przyszłość i pomagam uniknąć błędów.", "Wróżby", 90],
  ["marek", "Wróżbita Marek", "Wyjaśniam karmiczne przyczyny Twoich problemów.", "Wróżby", 100],
  ["pawel", "Wróżbita Paweł", "Pomagam podjąć właściwą decyzję.", "Wróżby", 110],
  ["tomasz", "Wróżbita Tomasz", "Runy pokażą odpowiedź na Twoje pytania.", "Wróżby", 120],
  ["monika", "Tarocistka Monika", "Tarot miłosny – uczucia i przyszłość relacji.", "Tarot", 130],
  ["katarzyna", "Tarocistka Katarzyna", "Pomagam zrozumieć siebie poprzez tarot.", "Tarot", 140],
  ["agnieszka", "Tarocistka Agnieszka", "Pokazuję Twoją drogę i potencjał.", "Tarot", 150],
  ["michal", "Tarocista Michał", "Konkretne odpowiedzi z kart tarota.", "Tarot", 160],
  ["piotr", "Tarocista Piotr", "Pomagam rozwiązać problemy i zrozumieć relacje.", "Tarot", 170],
  ["anna", "Astrolog Anna", "Odczytam Twój horoskop i życiową drogę.", "Astrologia", 180],
  ["magdalena", "Astrolog Magdalena", "Pokazuję wpływ planet na Twoje decyzje.", "Astrologia", 190],
  ["krzysztof", "Astrolog Krzysztof", "Odczytam Twoją karmę z gwiazd.", "Astrologia", 200],
  ["robert", "Astrolog Robert", "Wsparcie w finansach i pracy według astrologii.", "Astrologia", 210],
  ["barbara", "Jasnowidzka Barbara", "Widzę przyszłość i nadchodzące wydarzenia.", "Jasnowidzenie", 220],
  ["renata", "Jasnowidzka Renata", "Odczytuję energię i ukryte intencje.", "Jasnowidzenie", 230],
];
