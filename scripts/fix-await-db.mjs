import fs from "node:fs";

let s = fs.readFileSync("server.js", "utf8");
s = s.replace(/await db\s*\n\s*\.prepare\(/g, "await db.prepare(");
fs.writeFileSync("server.js", s);
console.log("merged await db + .prepare");
