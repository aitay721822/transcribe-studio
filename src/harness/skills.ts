import fs from 'node:fs/promises';
import path from 'node:path';
import type { Skill, WorkspaceRoot } from '../domain/models';

import { inside } from '../services/workspace/files';

export async function discoverSkills(roots: WorkspaceRoot[], bundled: string): Promise<Skill[]> {
  const skills: Skill[] = [];
  const bases = [
    { base: bundled, allowed: bundled },
    ...roots.flatMap((root) =>
      ['.agents', '.codex', '.claude'].map((directory) => ({
        base: path.join(root.path, directory, 'skills'),
        allowed: root.path,
      }))
    ),
  ];
  for (const { base, allowed } of bases) {
    try {
      const realBase = await fs.realpath(base);
      if (!inside(await fs.realpath(allowed), realBase)) continue;
      for (const entry of await fs.readdir(base, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        try {
          const file = await fs.realpath(path.join(base, entry.name, 'SKILL.md'));
          if (!inside(realBase, file) || (await fs.stat(file)).size > 64000) continue;
          const content = await fs.readFile(file, 'utf8');
          if (skills.some((skill) => skill.id === file)) continue;
          skills.push({
            id: file,
            name: content.match(/^name:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, '') || entry.name,
            description: content.match(/^description:\s*(.+)$/m)?.[1] || '',
            content,
          });
        } catch {}
      }
    } catch {}
  }
  return skills;
}
