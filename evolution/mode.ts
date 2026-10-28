import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export function detectRunMode(requirementsDir: string): "initial" | "evolution" {
  const file = path.join(requirementsDir, "requirements.yaml");
  if (!fs.existsSync(file)) throw new Error(`requirements.yaml not found: ${file}`);
  const root = YAML.parse(fs.readFileSync(file, "utf8"));
  if (!root || typeof root !== "object") throw new Error("Invalid requirement document");
  // Platform mount paths and root titles are not task identifiers. GitHub's
  // evolution document keeps its original title; the changes live in its body.
  const changed = (node: any): boolean => {
    if (!node || typeof node !== "object") return false;
    if (/\bModified Feature Description\b/i.test(String(node.description ?? ""))) return true;
    if (Array.isArray(node.scenarios) && node.scenarios.some((s: any) => /\bEvolution Scenario\b/i.test(String(s?.name ?? "")))) return true;
    return Array.isArray(node.children) && node.children.some(changed);
  };
  return changed(root) || /\bevolution\b/i.test(String(root.name ?? "")) || /(?:^|[-_])evolution(?:$|[-_])/i.test(path.basename(requirementsDir)) ? "evolution" : "initial";
}
