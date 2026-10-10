import fs from "node:fs";
import path from "node:path";
import type { JudgePacket } from "../judge-plan.js";

export function fixtureRoot(): Record<string, unknown> {
  return {
    id: "ROOT", type: "FOLDER", name: "Example evolution", description: "A local name editor.", data: { name: "Old", count: 0 },
    children: [{ id: "REQ-1", type: "ATOMIC", name: "Save name", description: "Modified Feature Description: Trim names and reject Reserved.", scenarios: [
      { name: "save", steps: [
        { keyword: "GIVEN", content: "The initial name is Old. The page has Name and Save controls." },
        { keyword: "WHEN", content: "Enter a padded name and Save." },
        { keyword: "THEN", content: "After saving, the trimmed name survives reload." },
      ] },
      { name: "refuse", steps: [
        { keyword: "GIVEN", content: "The initial name is Old. The page has Name and Save controls." },
        { keyword: "WHEN", content: "Enter Reserved and Save." },
        { keyword: "THEN", content: "Name already exists is visible and the name stays Old after reload." },
      ] },
      ...["first", "second"].map((name) => ({ name, steps: [
        { keyword: "GIVEN", content: "The counter starts at 0 and an Increment button is available." },
        { keyword: "WHEN", content: "Click Increment." },
        { keyword: "THEN", content: "Count is exactly 1 after the increment." },
      ] })),
    ] }],
  };
}

export function fixturePlan(packet: JudgePacket): Record<string, unknown> {
  const requirementId = packet.requirements[0].id;
  const label = { by: "label", text: "Name" };
  const cases = packet.requirements[0].scenarios.map((s, i) => ({
    id: `case-${i + 1}`, requirementId, scenarioId: s.id, purpose: i === 1 ? "negative" : i === 0 ? "persistence" : "happy_path",
    expectationBasis: [s.outcomes[0].text],
    steps: i < 2 ? [
      { op: "goto", value: "/" },
      { op: "fill", locator: label, value: i === 0 ? "  Fresh  " : "Reserved" },
      { op: "click", locator: { by: "role", role: "button", text: "Save" } },
      ...(i === 1 ? [{ op: "expectText", locator: { by: "role", role: "alert", text: "" }, value: "Name already exists" }] : []),
      { op: "reload" },
      { op: "expectValue", locator: label, value: i === 0 ? "Fresh" : "Old" },
    ] : [
      { op: "goto", value: "/" },
      { op: "click", locator: { by: "role", role: "button", text: "Increment" } },
      { op: "expectText", locator: { by: "role", role: "status", text: "Count" }, value: "1" },
    ],
    outcomeChecks: [{ outcomeId: s.outcomes[0].id, assertionIndexes: i === 0 ? [4] : i === 1 ? [3, 5] : [2] }],
  }));
  return { packetId: packet.id, cases, uncovered: [] };
}

export function createFixtureApp(root: string, broken: boolean): void {
  fs.mkdirSync(path.join(root, "frontend", "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(root, "frontend", "dist"), { recursive: true });
  fs.mkdirSync(path.join(root, "backend", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(root, "frontend", "package.json"), JSON.stringify({ scripts: { build: "node -e \"process.exit(0)\"" } }));
  fs.writeFileSync(path.join(root, "frontend", "dist", "index.html"), "<!doctype html><html></html>");
  fs.writeFileSync(path.join(root, "backend", "package.json"), JSON.stringify({ scripts: { start: "node app.cjs" } }));
  fs.writeFileSync(path.join(root, "backend", "state.json"), JSON.stringify({ name: "Old", count: 0 }));
  fs.writeFileSync(path.join(root, "backend", "app.cjs"), `
const fs = require('node:fs');
const http = require('node:http');
const esc = s => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const file = require('node:path').join(__dirname, 'state.json');
http.createServer(async (req, res) => {
  let state = JSON.parse(fs.readFileSync(file, 'utf8'));
  let message = '';
  if (req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.url === '/increment') state.count++;
    else {
      const input = new URLSearchParams(body).get('name') || '';
      const next = ${broken ? "input" : "input.trim()"}; // repair-marker
      if (next === 'Reserved') message = 'Name already exists'; else state.name = next;
    }
    fs.writeFileSync(file, JSON.stringify(state));
  }
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><html><body><form action="/" method="post"><label>Name<input name="name" value="' + esc(state.name) + '"></label><button>Save</button></form><div role="alert">' + message + '</div><form action="/increment" method="post"><button>Increment</button></form><output aria-label="Count">' + state.count + '</output></body></html>');
}).listen(Number(process.env.PORT), '127.0.0.1');
`);
}
