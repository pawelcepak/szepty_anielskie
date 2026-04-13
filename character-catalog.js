/** Wspólny katalog postaci (seed SQLite i PostgreSQL). */

export const DEFAULT_TYPICAL_HOURS = {
  "tarot-klasyczny": ["10:00", "13:00"],
  "tarot-intuicyjny": ["11:00", "15:00"],
  "runy-skandynawskie": ["09:00", "12:00"],
  "horoskop-dzienny": ["10:00", "14:00"],
  synastria: ["14:00", "18:00"],
  numerologia: ["08:00", "11:00"],
  pendulum: ["12:00", "15:00"],
  fusy: ["16:00", "20:00"],
  anioly: ["10:00", "12:00"],
  "sny-znaczenie": ["20:00", "23:00"],
  "astrologia-karmiczna": ["09:30", "13:30"],
  "karty-cygańskie": ["13:00", "17:00"],
  "energia-aury": ["18:00", "22:00"],
};

export const CHARACTER_PORTRAITS = {
  "tarot-klasyczny":
    "https://images.unsplash.com/photo-1551836022-d5d88e9218df?w=400&h=500&fit=crop&q=80",
  "tarot-intuicyjny":
    "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=400&h=500&fit=crop&q=80",
  "runy-skandynawskie":
    "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400&h=500&fit=crop&q=80",
  "horoskop-dzienny":
    "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=400&h=500&fit=crop&q=80",
  synastria:
    "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=400&h=500&fit=crop&q=80",
  numerologia:
    "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=400&h=500&fit=crop&q=80",
  pendulum:
    "https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?w=400&h=500&fit=crop&q=80",
  fusy: "https://images.unsplash.com/photo-1589156280159-27698a70f29e?w=400&h=500&fit=crop&q=80",
  anioly:
    "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=400&h=500&fit=crop&q=80",
  "sny-znaczenie":
    "https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=400&h=500&fit=crop&q=80",
  "astrologia-karmiczna":
    "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=400&h=500&fit=crop&q=80",
  "karty-cygańskie":
    "https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=400&h=500&fit=crop&q=80",
  "energia-aury":
    "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=400&h=500&fit=crop&q=80",
};

export const CHAR_ABOUT = {
  "tarot-klasyczny": {
    gender: "kobieta",
    skills:
      "Pracuję Riderem–Waite, układami na relacje i decyzje; zapraszam z konkretnym pytaniem — tak łatwiej Ci pomóc.",
    about:
      "Od lat układam karty klasycznie: łączę symbole talii z rozmową o tym, co naprawdę Cię ciąży. Szanuję Twoje tempo i delikatnie zarysowuję ramy czasu.",
  },
  "tarot-intuicyjny": {
    gender: "kobieta",
    skills:
      "Używam kart jak lustra — krótkie rozszerzenia, refleksja, coaching językiem obrazów z talii.",
    about:
      "Mniej „wróżenie z kart”, więcej wspólnego ułożenia sensu. Dobrze czuję tematy życiowe i momenty przejścia — jestem tu, żebyś wyszedł z rozmowy z lżejszą głową.",
  },
  "runy-skandynawskie": {
    gender: "mężczyzna",
    skills: "Futhark starszy, rzuty proste, pytania tak/nie i kierunkowe — wchodzę w temat szybko i jasno.",
    about:
      "Lubię krótkie, konkretne pytania i decyzje „dziś albo jutro”. Jeśli potrzebujesz prostego sygnału z run, napisz — ułożę rzut i wytłumaczę go po ludzku.",
  },
  "horoskop-dzienny": {
    gender: "kobieta",
    skills: "Mapa urodzeniowa, Słońce, Księżyc, ascendent i przebieg tygodnia — tłumaczę to przystępnie.",
    about:
      "Pomagam zobaczyć Twój tydzień i siebie w kontekście gwiazd, bez żargonu dla „wtajemniczonych”. Jeśli chcesz złapać rytm dni, zapraszam na rozmowę.",
  },
  synastria: {
    gender: "mężczyzna",
    skills: "Porównuję dwie mapy — dynamika pary, napięcia i miejsca na wsparcie.",
    about:
      "Patrzę na związek przez pryzmat astrologii: co się klei, co wymaga pracy. Potrzebuję dokładnych dat urodzenia obu osób — wtedy mogę wejść w temat uczciwie i konkretnie.",
  },
  numerologia: {
    gender: "kobieta",
    skills: "Liczba drogi życia, pętle, imię i data — szukam w liczbach tego, co pasuje do Twojej historii.",
    about:
      "Łączę cyfry z etapem życia i wyborem zawodowym lub relacyjnym. Jeśli lubisz uporządkowane podpowiedzi z nutą intuicji, zajrzymy razem w Twój profil liczb.",
  },
  pendulum: {
    gender: "kobieta",
    skills: "Wahadło, wybór z kilku opcji, proste pytania decyzyjne — krótko i na temat.",
    about:
      "Najlepiej sprawdzam się, gdy masz 2–4 nazwane ścieżki i chcesz lekkiego „kierunku”. Napisz dylemat — przejdziemy przez niego w spokojnym tempie.",
  },
  fusy: {
    gender: "kobieta",
    skills: "Fusy w kubku po zaparzeniu — tradycyjne skojarzenia i ciepły, domowy ton.",
    about:
      "Zapraszam do krótkiej historii za pytaniem: fusy lubią kontekst. Pracuję spokojnie, bez pośpiechu — idealnie, jeśli szukasz klimatu „przy stole w kuchni”.",
  },
  anioly: {
    gender: "kobieta",
    skills: "Karty anielskie, łagodny komunikat i ton wsparcia — bez straszenia.",
    about:
      "Stawiam na pocieszenie i perspektywę. Jeśli czujesz stres albo niepewność co do przyszłości, mogę pomóc złapać oddech i zobaczyć rzeczy łagodniej.",
  },
  "sny-znaczenie": {
    gender: "kobieta",
    skills: "Symbolika snów, powtarzalne motywy, emocje ukryte pod obrazem snu.",
    about:
      "Pomagam rozkodować sny, które wracają noc po nocy. Łączę symbole z Twoją codziennością i podpowiadam, co może wołać o uwagę.",
  },
  "astrologia-karmiczna": {
    gender: "mężczyzna",
    skills: "Węzły księżycowe, lekcje karmiczne, cykle przełomów życiowych.",
    about:
      "Patrzę szerzej niż horoskop dnia. Jeśli czujesz, że powtarzasz te same scenariusze, przeanalizujemy je przez karmiczne osie mapy.",
  },
  "karty-cygańskie": {
    gender: "kobieta",
    skills: "Tradycyjny rozkład kart cygańskich, pytania relacyjne i domowe.",
    about:
      "Pracuję klasycznie i spokojnie. Dobrze prowadzę tematy sercowe oraz rodzinne, gdzie potrzeba ciepłego, ale konkretnego spojrzenia.",
  },
  "energia-aury": {
    gender: "kobieta",
    skills: "Czytanie energii aury, oczyszczanie intencji i kierunek na najbliższy czas.",
    about:
      "Skupiam się na tym, co wzmacnia, a co osłabia Twoją energię. Rozmowa jest łagodna, ale praktyczna: dostajesz jasne kroki na dziś.",
  },
};

export const EXTRA_OR_BASE_ROWS = [
  ["tarot-klasyczny", "Anna W. — tarot klasyczny", "Rider–Waite, układy na relacje i decyzje", "Tarot", 10],
  ["tarot-intuicyjny", "Maja K. — tarot intuicyjny", "Karty jako punkt wyjścia do rozmowy", "Tarot", 20],
  ["runy-skandynawskie", "Erik L. — runy", "Futhark, pytania proste / tak–nie", "Runy", 30],
  ["horoskop-dzienny", "Dorota S. — horoskop osobisty", "Słońce, ascendent, przebiegi tygodnia", "Astrologia", 40],
  ["synastria", "Piotr M. — analiza pary", "Porównanie map: dynamika związku", "Astrologia", 50],
  ["numerologia", "Iza N. — numerologia imienia i daty", "Liczbę drogi życia, cykle roczne", "Numerologia", 60],
  ["pendulum", "Karolina P. — wahadło", "Krótkie pytania, wybór z kilku opcji", "Inne techniki", 70],
  ["fusy", "Bożena T. — wróżba z fusów", "Symbolika kubka, domowy klimat", "Tradycyjne", 80],
  ["anioly", "Magdalena R. — karty anielskie", "Komunikat łagodny, wspierający", "Karty", 90],
  ["sny-znaczenie", "Nina Ś. — znaczenie snów", "Sny, symbole i intuicyjne odczyty", "Sny", 100],
  ["astrologia-karmiczna", "Oskar V. — astrologia karmiczna", "Węzły karmiczne i cykle życia", "Astrologia", 110],
  ["karty-cygańskie", "Ewa C. — karty cygańskie", "Tradycyjne rozkłady relacyjne", "Karty", 120],
  ["energia-aury", "Lena A. — odczyt aury", "Energia, blokady i kierunek", "Energetyka", 130],
];
