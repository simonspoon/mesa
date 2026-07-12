import type { Project } from './types/Project'

/** The project whose `local_path` is `cwd` or a parent of it — the same
 * prefix relationship `claude agents --cwd` itself matches on. Ties (nested
 * project folders) favor the longest/most-specific `local_path`. */
export function projectForCwd(cwd: string, projects: Project[]): Project | undefined {
  return projects
    .filter(
      (p) =>
        p.local_path !== null &&
        (cwd === p.local_path || cwd.startsWith(p.local_path + '/')),
    )
    .sort((a, b) => b.local_path!.length - a.local_path!.length)[0]
}
