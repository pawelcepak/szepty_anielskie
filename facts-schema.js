/**
 * Słownik pól notatek strukturalnych (klient / konsultant).
 * Walidacja PATCH — zmiana struktury tylko tutaj + migracja w db.js.
 *
 * `fieldGroups` — prezentacja (select + lista): podkategorie w obrębie kategorii.
 */
export const FACT_SCHEMA = {
  client: {
    dane_osobowe: {
      label: "Dane osobowe",
      fieldGroups: [
        { label: "Imię", keys: ["imie"] },
        { label: "Wiek", keys: ["wiek"] },
        { label: "Miasto", keys: ["miasto"] },
        { label: "Reszta", keys: ["reszta"] },
      ],
      fields: {
        imie: "Imię",
        wiek: "Wiek",
        miasto: "Miasto",
        reszta: "Reszta",
      },
    },
    rodzina: {
      label: "Rodzina",
      fields: {
        notatka: "Notatka",
      },
    },
    zainteresowania: {
      label: "Zainteresowania",
      fieldGroups: [
        { label: "Sport", keys: ["sport"] },
        { label: "Hobby", keys: ["hobby"] },
      ],
      fields: {
        sport: "Sport",
        hobby: "Hobby",
      },
    },
    zdrowie: {
      label: "Zdrowie",
      fieldGroups: [
        { label: "Klient", keys: ["klient"] },
        { label: "Rodzina klienta", keys: ["rodzina_klienta"] },
      ],
      fields: {
        klient: "Klient",
        rodzina_klienta: "Rodzina klienta",
      },
    },
    inne: {
      label: "Inne",
      fields: {
        notatka: "Notatka",
      },
    },
  },
  consultant: {
    persona: {
      label: "Medium",
      fields: {
        style: "Styl tonu",
        taboos: "Czego unikać",
        notes: "Uwagi do wątku",
      },
    },
    other: {
      label: "Inne",
      fields: {
        misc: "Różne — nie pasuje do pozostałych kategorii",
        scratch: "Szybkie zapiski / tymczasowe",
      },
    },
  },
};

export function isValidFactKey(scope, category, field) {
  const s = FACT_SCHEMA[scope];
  if (!s) return false;
  const c = s[category];
  if (!c?.fields) return false;
  return Object.prototype.hasOwnProperty.call(c.fields, field);
}

/** Limit długości jednej notatki (ochrona przed wklejaniem całych wiadomości klienta). */
export const FACT_VALUE_MAX_LEN = 150;

export function flattenSchemaForApi() {
  const out = { client: [], consultant: [] };
  for (const scope of ["client", "consultant"]) {
    const block = FACT_SCHEMA[scope];
    for (const [catKey, cat] of Object.entries(block)) {
      const entry = {
        key: catKey,
        label: cat.label,
        subtitle: cat.subtitle || null,
        fieldGroups: cat.fieldGroups
          ? cat.fieldGroups.map((g) => ({ label: g.label, keys: [...g.keys] }))
          : null,
        fields: Object.entries(cat.fields).map(([k, label]) => ({ key: k, label })),
      };
      out[scope].push(entry);
    }
  }
  return out;
}
