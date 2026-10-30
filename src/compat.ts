/** Official model editors supersede these enhancements at the named releases. */
export function legacyModelEditors(version?: string): { inputTypes: boolean; reasoningLevels: boolean } {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version ?? '');
  if (!match) return { inputTypes: false, reasoningLevels: false };
  const before = (minor: number, patch: number, rc: number): boolean => {
    const core = [+match[1], +match[2], +match[3]], target = [0, minor, patch];
    for (let i = 0; i < 3; i++) if (core[i] !== target[i]) return core[i] < target[i];
    if (!match[4]) return false;
    const [kind, number] = match[4].split('.');
    return kind === 'alpha' || kind === 'beta' || kind === 'rc' && Number(number) < rc;
  };
  return { inputTypes: before(1, 7, 1), reasoningLevels: before(2, 1, 1) };
}

/** The two official integrations are enabled from these releases, inclusive. */
export function officialModelIntegrations(version?: string): { autoReview: boolean; translation: boolean } {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version ?? '');
  if (!match) return { autoReview: false, translation: false };
  const atLeast = (minor: number, patch: number, rc: number): boolean => {
    const current = [+match[1], +match[2], +match[3]], target = [0, minor, patch];
    for (let i=0; i<3; i++) if (current[i] !== target[i]) return current[i] > target[i];
    if (!match[4]) return true;
    const [kind, number] = match[4].split('.');
    return kind === 'rc' && Number(number) >= rc;
  };
  return { autoReview: atLeast(1, 7, 2), translation: atLeast(2, 1, 1) };
}
