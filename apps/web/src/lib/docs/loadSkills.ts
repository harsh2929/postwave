// SPDX-License-Identifier: AGPL-3.0-only

// Rich MCP documentation is generated from packages/mcp-server at review/build
// time. Runtime routes consume this bounded JSON artifact instead of shipping
// TypeScript tool sources in the production container.
import generatedSkillDetails from "../mcp-tool-details.generated.json";

export interface SkillCatalogEntry {
  name: string;
  category: string;
  description: string;
}

export interface SkillDetails extends SkillCatalogEntry {
  fullDescription: string;
  inputFields: SkillField[];
  hasCustomTimeout: boolean;
  source: string;
  slug: string;
}

export interface SkillField {
  name: string;
  kind: string;
  optional: boolean;
  description?: string;
  enumValues?: string[];
}

const skills = generatedSkillDetails as SkillDetails[];
let cachedByCategory: Map<string, SkillDetails[]> | null = null;

export function listSkills(): SkillDetails[] {
  return skills;
}

export function listSkillSlugs(): { skill: string }[] {
  return skills.map((skill) => ({ skill: skill.slug }));
}

export function findSkillBySlug(slug: string): SkillDetails | undefined {
  return skills.find((skill) => skill.slug === slug);
}

export function skillsByCategory(): {
  category: string;
  skills: SkillDetails[];
}[] {
  if (!cachedByCategory) {
    const grouped = new Map<string, SkillDetails[]>();
    for (const skill of skills) {
      if (!grouped.has(skill.category)) grouped.set(skill.category, []);
      grouped.get(skill.category)!.push(skill);
    }
    cachedByCategory = grouped;
  }

  return Array.from(cachedByCategory.entries())
    .map(([category, categorySkills]) => ({
      category,
      skills: [...categorySkills].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    }))
    .sort((left, right) => left.category.localeCompare(right.category));
}
