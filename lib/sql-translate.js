/**
 * Tłumaczenie zapytań w stylu SQLite (używanych w tym projekcie) na PostgreSQL.
 * Kolejność: najpierw zagnieżdżone datetime(), potem date().
 */

function translateDatetimeInner(inner) {
  const t = inner.trim();
  if (t === "'now'") return "(NOW() AT TIME ZONE 'UTC')";
  const m = /^'now'\s*,\s*'([^']*)'\s*$/s.exec(t);
  if (m) {
    const mod = m[1].trim();
    const p = /^(-?\d+)\s+(day|days|hour|hours)$/i.exec(mod);
    if (p) {
      const n = parseInt(p[1], 10);
      const abs = Math.abs(n);
      const unit = p[2].toLowerCase().startsWith("hour") ? "hours" : "days";
      const op = n < 0 ? "-" : "+";
      return `(NOW() AT TIME ZONE 'UTC' ${op} INTERVAL '${abs} ${unit}')`;
    }
  }
  return `(${t}::timestamptz)`;
}

function replaceAllDatetime(sql) {
  let s = sql;
  let guard = 0;
  while (s.includes("datetime(") && guard++ < 500) {
    const pos = s.indexOf("datetime(");
    if (pos === -1) break;
    const start = pos + "datetime(".length;
    let depth = 1;
    let j = start;
    while (j < s.length && depth > 0) {
      const c = s[j];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      j++;
    }
    let inner = s.slice(start, j - 1);
    if (inner.includes("datetime(")) {
      inner = replaceAllDatetime(inner);
    }
    const repl = translateDatetimeInner(inner);
    s = s.slice(0, pos) + repl + s.slice(j);
  }
  return s;
}

export function translateSqliteToPostgres(sql) {
  let s = sql.replace(/\bIFNULL\b/gi, "COALESCE");
  s = replaceAllDatetime(s);
  s = s.replace(/\bdate\(\s*'now'\s*\)/gi, "CURRENT_DATE");
  s = s.replace(/\bdate\(\s*([^)]+?)\s*\)/gi, (match, inner) => {
    const t = String(inner).trim();
    if (t === "'now'") return "CURRENT_DATE";
    return `((${t})::timestamptz)::date`;
  });
  s = s.replace(/([\w.]+)\s+COLLATE\s+NOCASE/gi, "LOWER($1)");
  return s;
}

export function toPgParams(sql, params) {
  const values = [];
  let i = 0;
  const query = sql.replace(/\?/g, () => {
    if (i >= params.length) throw new Error("Za mało parametrów dla ? w zapytaniu SQL.");
    const n = values.length + 1;
    values.push(params[i++]);
    return `$${n}`;
  });
  if (i !== params.length) {
    throw new Error(`Liczba parametrów SQL: oczekiwano ${i}, podano ${params.length}.`);
  }
  return { query, values };
}
